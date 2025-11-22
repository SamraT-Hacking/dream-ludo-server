
// /dream-ludo-server/game.js
const { v4: uuidv4 } = require('uuid');

// --- Enums and Constants (mirrored from frontend) ---
const PlayerColor = { Red: 'Red', Green: 'Green', Blue: 'Blue', Yellow: 'Yellow' };
const PieceState = { Home: 'Home', Active: 'Active', Finished: 'Finished' };
const GameStatus = { Setup: 'Setup', Playing: 'Playing', Finished: 'Finished' };

const TOTAL_PATH_LENGTH = 52;
const HOME_STRETCH_LENGTH = 6;
const FINISH_POSITION_START = 100;
const TURN_TIME_LIMIT = 30;
const MAX_INACTIVE_TURNS = 5; 

const START_POSITIONS = {
  [PlayerColor.Green]: 1,
  [PlayerColor.Red]: 14,
  [PlayerColor.Yellow]: 40,
  [PlayerColor.Blue]: 27,
};

const PRE_HOME_POSITIONS = {
  [PlayerColor.Green]: 51,
  [PlayerColor.Red]: 12,
  [PlayerColor.Yellow]: 38,
  [PlayerColor.Blue]: 25,
};

const SAFE_SPOTS = [1, 9, 14, 22, 27, 35, 40, 48];
const ALL_COLORS = [PlayerColor.Red, PlayerColor.Green, PlayerColor.Blue, PlayerColor.Yellow];
const TWO_PLAYER_COLORS = [PlayerColor.Green, PlayerColor.Blue];

// --- Helper Functions ---

/**
 * Creates the initial state for a single player.
 */
function createPlayer(playerId, name, color, isHost = false) {
  const pieces = Array.from({ length: 4 }, (_, i) => ({
    id: ALL_COLORS.indexOf(color) * 4 + i,
    color: color,
    state: PieceState.Home,
    position: -1,
  }));
  return {
    playerId,
    name,
    color,
    pieces,
    isHost,
    hasFinished: false,
    isRemoved: false,
    inactiveTurns: 0,
    consecutiveSixes: 0, // Rule 1.1: Track consecutive 6s
    rollsWithoutSix: 0,  // Rule 2: Track rolls without 6 when stuck
  };
}

/**
 * Calculates the new position of a piece after a move.
 */
function getNewPositionInfo(piece, diceValue) {
    if (piece.state === PieceState.Home && diceValue === 6) {
        return { position: START_POSITIONS[piece.color], state: PieceState.Active };
    }

    if (piece.state === PieceState.Active) {
        let newPos;
        if (piece.position >= FINISH_POSITION_START) { // Already in home stretch
            newPos = piece.position + diceValue;
            if (newPos === FINISH_POSITION_START + HOME_STRETCH_LENGTH - 1) return { position: newPos, state: PieceState.Finished };
            if (newPos < FINISH_POSITION_START + HOME_STRETCH_LENGTH) return { position: newPos, state: PieceState.Active };
        } else { // On main path
            const preHomePos = PRE_HOME_POSITIONS[piece.color];
            // Calculate distance to the entry of the home stretch
            const distToPreHome = (preHomePos - piece.position + TOTAL_PATH_LENGTH) % TOTAL_PATH_LENGTH;
            if (diceValue > distToPreHome) { // Will enter home stretch
                const homeStretchPos = diceValue - distToPreHome - 1;
                if (homeStretchPos < HOME_STRETCH_LENGTH) {
                    newPos = FINISH_POSITION_START + homeStretchPos;
                    if (homeStretchPos === HOME_STRETCH_LENGTH - 1) return { position: newPos, state: PieceState.Finished };
                    return { position: newPos, state: PieceState.Active };
                }
            } else { // Stays on main path (using clearer 0-based calculation)
                const zeroBasedPos = piece.position - 1;
                const newZeroBasedPos = (zeroBasedPos + diceValue) % TOTAL_PATH_LENGTH;
                newPos = newZeroBasedPos + 1;
                return { position: newPos, state: PieceState.Active };
            }
        }
    }
    return { position: piece.position, state: piece.state }; // Invalid move
}


/**
 * Finds which pieces can legally move given a dice roll.
 */
function calculateMovablePieces(player, diceValue) {
    const movable = [];
    for (const piece of player.pieces) {
        const { position: newPos, state: newState } = getNewPositionInfo(piece, diceValue);
        if (newState !== piece.state || newPos !== piece.position) {
            movable.push(piece.id);
        }
    }
    return movable;
}

/**
 * Helper to log turn activity to both in-memory state and database.
 */
async function logTurnActivity(gameState, turnData, supabase) {
    gameState.turn_history.push(turnData);

    if (gameState.tournamentId && supabase) {
        try {
            const { error } = await supabase.from('game_turn_history').insert({
                tournament_id: gameState.tournamentId,
                user_id: turnData.userId,
                username: turnData.name,
                description: turnData.description,
            });
            if (error) console.error('Error saving turn history:', error.message);
        } catch (e) {
            console.error('Exception saving turn history:', e.message);
        }
    }
}


/**
 * Moves to the next active player.
 */
async function advanceTurn(gameState, supabase) {
    if (gameState.gameStatus !== GameStatus.Playing) return;

    let nextIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
    let checkedAll = 0;
    
    while (
        (gameState.players[nextIndex].hasFinished || gameState.players[nextIndex].isRemoved) && 
        checkedAll < gameState.players.length
    ) {
        nextIndex = (nextIndex + 1) % gameState.players.length;
        checkedAll++;
    }

    const activePlayers = gameState.players.filter(p => !p.isRemoved && !p.hasFinished);
    if (activePlayers.length === 0 && gameState.players.length > 1) {
        gameState.gameStatus = GameStatus.Finished;
        gameState.winner = null;
        gameState.message = "Game Over! No active players left.";
        await logTurnActivity(gameState, { description: `Game finished. No winner.` }, supabase);
        return;
    }

    // Reset state for the next player
    gameState.players[nextIndex].consecutiveSixes = 0; // Reset 6s counter on new turn
    gameState.currentPlayerIndex = nextIndex;
    gameState.diceValue = null;
    gameState.isRolling = false;
    gameState.movablePieces = [];
    gameState.turnTimeLeft = TURN_TIME_LIMIT;
    gameState.message = `${gameState.players[nextIndex].name}'s turn.`;
}

// --- Core Game Logic Functions ---

/**
 * Creates a new game state object.
 */
function createNewGame(gameId, options = {}) {
  const { hostId, hostName, type = 'manual', max_players = 2, players: initialPlayers = [], tournamentId } = options;
  
  const gameState = {
    gameId,
    hostId,
    type,
    max_players,
    tournamentId,
    players: [],
    playerOrder: [],
    currentPlayerIndex: 0,
    diceValue: null,
    gameStatus: GameStatus.Setup,
    winner: null,
    message: 'Waiting for players...',
    movablePieces: [],
    isRolling: false,
    turnTimeLeft: TURN_TIME_LIMIT,
    chatMessages: [],
    turn_history: [],
  };

  initialPlayers.forEach(p => addPlayer(gameState, p.id, p.name));
  
  return gameState;
}

/**
 * Adds a new player to the game during setup.
 */
function addPlayer(gameState, playerId, playerName) {
    if (gameState.gameStatus !== GameStatus.Setup) return;
    if (gameState.players.length >= gameState.max_players) return;
    if (gameState.players.some(p => p.playerId === playerId)) return;

    const isHost = gameState.players.length === 0;
    let color;
    if (gameState.max_players === 2) {
        color = TWO_PLAYER_COLORS[gameState.players.length];
    } else {
        color = ALL_COLORS[gameState.players.length];
    }
    const player = createPlayer(playerId, playerName, color, isHost);
    
    gameState.players.push(player);
    gameState.message = `${playerName} joined the game!`;
}

/**
 * Starts the game, sets player order, and begins the first turn.
 */
async function startGame(gameState, requestingPlayerId, supabase) {
    if (requestingPlayerId && gameState.hostId !== requestingPlayerId) {
        gameState.message = "Only the host can start the game.";
        return;
    }
    if (gameState.gameStatus !== GameStatus.Setup || gameState.players.length < 2) {
        gameState.message = "Need at least 2 players to start.";
        return;
    }

    gameState.gameStatus = GameStatus.Playing;
    gameState.playerOrder = gameState.players.map(p => p.color);
    gameState.currentPlayerIndex = 0;
    gameState.turnTimeLeft = TURN_TIME_LIMIT;
    gameState.message = `Game started! ${gameState.players[0].name}'s turn.`;
    await logTurnActivity(gameState, { description: 'Game started.' }, supabase);
}

function initiateRoll(gameState, playerId) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (currentPlayer.playerId !== playerId || gameState.diceValue !== null || gameState.isRolling) return;
    gameState.isRolling = true;
    gameState.message = `${currentPlayer.name} is rolling...`;
}

async function completeRoll(gameState, playerId, supabase) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (currentPlayer.playerId !== playerId || !gameState.isRolling) return;
    
    currentPlayer.inactiveTurns = 0; // Player took an action, reset counter.

    // Rule 2: Forced 6 if no pieces on board and failed multiple times
    const allPiecesHome = currentPlayer.pieces.every(p => p.state === PieceState.Home);
    let diceValue;

    // If all pieces are home and they've rolled 4 times without a 6 (this is the 5th try), force a 6.
    // Assuming logic: "4-5 times" -> Force on 5th attempt if count is 4.
    if (allPiecesHome && currentPlayer.rollsWithoutSix >= 4) {
        diceValue = 6;
    } else {
        diceValue = Math.floor(Math.random() * 6) + 1;
    }

    gameState.diceValue = diceValue;
    gameState.isRolling = false;
    
    // Update 6 counters
    if (diceValue === 6) {
        currentPlayer.rollsWithoutSix = 0; // Reset pity counter
        currentPlayer.consecutiveSixes += 1;
    } else {
        if (allPiecesHome) {
            currentPlayer.rollsWithoutSix += 1;
        }
        currentPlayer.consecutiveSixes = 0; // Reset sequence
    }

    // Rule 1.1: Three 6s in a row penalty
    if (currentPlayer.consecutiveSixes === 3) {
        gameState.message = `${currentPlayer.name} rolled three 6s! Turn forfeited.`;
        await logTurnActivity(gameState, { 
            userId: currentPlayer.playerId, 
            name: currentPlayer.name, 
            description: `rolled a 3rd six (penalty). Turn lost.` 
        }, supabase);
        
        // End turn immediately
        await advanceTurn(gameState, supabase);
        return true; // Signal that turn is handled (no moves to calculate)
    }

    const movablePieces = calculateMovablePieces(currentPlayer, diceValue);
    gameState.movablePieces = movablePieces;
    gameState.message = `${currentPlayer.name} rolled a ${diceValue}.`;
    await logTurnActivity(gameState, { userId: currentPlayer.playerId, name: currentPlayer.name, description: `rolled a ${diceValue}.` }, supabase);

    if (movablePieces.length === 0) {
        return true; // Indicates roll complete, but no moves, caller should handle turn pass delay
    }
    return false;
}

async function movePiece(gameState, playerId, pieceId, supabase) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (currentPlayer.playerId !== playerId || !gameState.movablePieces.includes(pieceId)) return;

    currentPlayer.inactiveTurns = 0; // Player took an action, reset counter.

    const pieceToMove = currentPlayer.pieces.find(p => p.id === pieceId);
    if (!pieceToMove) return;

    const { position: newPos, state: newState } = getNewPositionInfo(pieceToMove, gameState.diceValue);
    
    pieceToMove.position = newPos;
    pieceToMove.state = newState;
    await logTurnActivity(gameState, { userId: currentPlayer.playerId, name: currentPlayer.name, description: `moved piece to position ${newPos}.` }, supabase);

    let capturedPiece = false;
    let pieceFinished = false; // Track Rule 3
    gameState.message = `${currentPlayer.name} moved a piece.`;

    // Check capture
    if (newState === PieceState.Active && newPos < FINISH_POSITION_START && !SAFE_SPOTS.includes(newPos)) {
        for (const opponent of gameState.players) {
            if (opponent.color === currentPlayer.color) continue;
            for (const oppPiece of opponent.pieces) {
                if (oppPiece.position === newPos) {
                    oppPiece.state = PieceState.Home;
                    oppPiece.position = -1;
                    gameState.message = `${currentPlayer.name} captured ${opponent.name}'s piece!`;
                    await logTurnActivity(gameState, { userId: currentPlayer.playerId, name: currentPlayer.name, description: `captured ${opponent.name}'s piece.` }, supabase);
                    capturedPiece = true;
                }
            }
        }
    }

    // Rule 3: Check if piece finished
    if (newState === PieceState.Finished) {
        pieceFinished = true;
        gameState.message = `${currentPlayer.name}'s piece reached Home! Extra Turn.`;
        await logTurnActivity(gameState, { userId: currentPlayer.playerId, name: currentPlayer.name, description: `piece reached home.` }, supabase);
    }

    // Check Win Condition
    if (currentPlayer.pieces.every(p => p.state === PieceState.Finished)) {
        currentPlayer.hasFinished = true;
        gameState.winner = currentPlayer;
        gameState.gameStatus = GameStatus.Finished;
        gameState.message = `${currentPlayer.name} wins the game!`;
        await logTurnActivity(gameState, { description: `Game finished. Winner: ${currentPlayer.name}` }, supabase);
        return;
    }

    // Logic for Extra Turn:
    // 1. Rule 1: Rolled a 6
    // 2. Capture: Captured opponent piece
    // 3. Rule 3: Piece reached Home
    if (gameState.diceValue === 6 || capturedPiece || pieceFinished) {
        gameState.diceValue = null;
        gameState.movablePieces = [];
        gameState.isRolling = false;
        // If it wasn't a 6 that caused the extra turn (e.g. finished with a 3), we reset consecutive sixes
        if (gameState.diceValue !== 6) {
             currentPlayer.consecutiveSixes = 0;
        }
        gameState.message += " Roll again!";
        gameState.turnTimeLeft = TURN_TIME_LIMIT;
    } else {
        await advanceTurn(gameState, supabase);
    }
}

async function handleMissedTurn(gameState, supabase) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (!currentPlayer || gameState.gameStatus !== GameStatus.Playing) return;

    currentPlayer.inactiveTurns += 1;
    gameState.message = `${currentPlayer.name} missed their turn.`;
    await logTurnActivity(gameState, { userId: currentPlayer.playerId, name: currentPlayer.name, description: `missed their turn.` }, supabase);

    if (currentPlayer.inactiveTurns >= MAX_INACTIVE_TURNS) {
        await leaveGame(gameState, currentPlayer.playerId, supabase);
    } else {
        await advanceTurn(gameState, supabase);
    }
}

async function leaveGame(gameState, playerId, supabase) {
    const player = gameState.players.find(p => p.playerId === playerId);
    if (player && !player.isRemoved) {
        player.isRemoved = true;
        gameState.message = `${player.name} left the game.`;
        await logTurnActivity(gameState, { userId: player.playerId, name: player.name, description: `left the game.` }, supabase);
        
        // Check if there is only one active player left to declare a winner.
        const activePlayers = gameState.players.filter(p => !p.isRemoved && !p.hasFinished);
        if (activePlayers.length === 1) {
            const winner = activePlayers[0];
            gameState.winner = winner;
            gameState.gameStatus = GameStatus.Finished;
            gameState.message = `${winner.name} wins as the opponent left the game!`;
            await logTurnActivity(gameState, { userId: winner.playerId, name: winner.name, description: `won because opponent left.` }, supabase);
            return; // Game is over, no need to advance turn.
        }
        
        if (gameState.players[gameState.currentPlayerIndex].playerId === playerId) {
            await advanceTurn(gameState, supabase);
        }
    }
}

async function sendChatMessage(gameState, playerId, text, supabase) {
    const player = gameState.players.find(p => p.playerId === playerId);
    if (!player) return;

    const message = {
        id: uuidv4(),
        game_code: gameState.gameId,
        playerId,
        name: player.name,
        color: player.color,
        text,
        timestamp: Date.now(),
    };

    if (!gameState.chatMessages) gameState.chatMessages = [];
    gameState.chatMessages.push(message);
    if (gameState.chatMessages.length > 50) gameState.chatMessages.shift();
    
    if (gameState.tournamentId && supabase) {
        try {
            const { error } = await supabase.from('chat_messages').insert({
                tournament_id: gameState.tournamentId,
                user_id: playerId,
                username: player.name,
                message_text: text,
            });
            if (error) {
                console.error('Supabase error saving chat message:', error.message);
            }
        } catch(e) {
            console.error('Exception while trying to save chat message:', e.message);
        }
    }
}

module.exports = {
    createNewGame, addPlayer, startGame,
    initiateRoll, completeRoll, movePiece,
    leaveGame, sendChatMessage, handleMissedTurn,
    advanceTurn
};
