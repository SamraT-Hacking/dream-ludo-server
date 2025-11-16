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
const MAX_INACTIVE_TURNS = 3;

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
    disconnected: false,
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
 * Moves to the next active player.
 */
function advanceTurn(gameState) {
    if (gameState.gameStatus !== GameStatus.Playing) return;
    
    // Reset current player's inactive turns since they made a move
    if (gameState.players[gameState.currentPlayerIndex]) {
        gameState.players[gameState.currentPlayerIndex].inactiveTurns = 0;
    }

    let nextIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
    let checkedAll = 0;
    
    // Skip players who have finished, been removed, or are disconnected
    while (
        (gameState.players[nextIndex].hasFinished || gameState.players[nextIndex].isRemoved || gameState.players[nextIndex].disconnected) && 
        checkedAll < gameState.players.length
    ) {
        nextIndex = (nextIndex + 1) % gameState.players.length;
        checkedAll++;
    }

    // If all remaining players have finished or left, end the game.
    const activePlayers = gameState.players.filter(p => !p.isRemoved && !p.hasFinished);
    if (activePlayers.length <= 1 && gameState.players.length > 1) {
        gameState.gameStatus = GameStatus.Finished;
        gameState.winner = activePlayers[0] || null; // The last one standing is the winner
        gameState.message = "Game Over!";
        gameState.turn_history.push({ description: `Game finished. Winner: ${gameState.winner?.name || 'None'}` });
        return;
    }

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
  const { hostId, hostName, type = 'manual', max_players = 2, players: initialPlayers = [] } = options;
  
  const gameState = {
    gameId,
    hostId,
    type,
    max_players,
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
    if (gameState.players.some(p => p.playerId === playerId)) return; // Already in game

    const isHost = gameState.players.length === 0;
    const color = ALL_COLORS[gameState.players.length];
    const player = createPlayer(playerId, playerName, color, isHost);
    
    gameState.players.push(player);
    gameState.message = `${playerName} joined the game!`;
}

/**
 * Starts the game, sets player order, and begins the first turn.
 */
function startGame(gameState, requestingPlayerId) {
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
    gameState.turn_history.push({ description: 'Game started.' });
}

function initiateRoll(gameState, playerId) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (currentPlayer.playerId !== playerId || gameState.diceValue !== null || gameState.isRolling) return;
    gameState.isRolling = true;
    gameState.message = `${currentPlayer.name} is rolling...`;
}

function completeRoll(gameState, playerId) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (currentPlayer.playerId !== playerId || !gameState.isRolling) return;

    const diceValue = Math.floor(Math.random() * 6) + 1;
    gameState.diceValue = diceValue;
    gameState.isRolling = false;
    
    const movablePieces = calculateMovablePieces(currentPlayer, diceValue);
    gameState.movablePieces = movablePieces;
    gameState.message = `${currentPlayer.name} rolled a ${diceValue}.`;
    gameState.turn_history.push({ userId: currentPlayer.playerId, name: currentPlayer.name, description: `rolled a ${diceValue}.` });


    if (movablePieces.length === 0) {
        // Use a short delay before auto-advancing turn to let players see the roll.
        // The server will handle this with a timeout.
        return true; // Indicates that the turn should advance
    }
    return false;
}

function movePiece(gameState, playerId, pieceId) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (currentPlayer.playerId !== playerId || !gameState.movablePieces.includes(pieceId)) return;

    const pieceToMove = currentPlayer.pieces.find(p => p.id === pieceId);
    if (!pieceToMove) return;

    const { position: newPos, state: newState } = getNewPositionInfo(pieceToMove, gameState.diceValue);
    
    pieceToMove.position = newPos;
    pieceToMove.state = newState;
    gameState.turn_history.push({ userId: currentPlayer.playerId, name: currentPlayer.name, description: `moved piece to position ${newPos}.` });


    let capturedPiece = false;
    gameState.message = `${currentPlayer.name} moved a piece.`;

    if (newState === PieceState.Active && newPos < FINISH_POSITION_START && !SAFE_SPOTS.includes(newPos)) {
        gameState.players.forEach(opponent => {
            if (opponent.color === currentPlayer.color) return;
            opponent.pieces.forEach(oppPiece => {
                if (oppPiece.position === newPos) {
                    oppPiece.state = PieceState.Home;
                    oppPiece.position = -1;
                    gameState.message = `${currentPlayer.name} captured ${opponent.name}'s piece!`;
                    gameState.turn_history.push({ userId: currentPlayer.playerId, name: currentPlayer.name, description: `captured ${opponent.name}'s piece.` });
                    capturedPiece = true;
                }
            });
        });
    }

    if (currentPlayer.pieces.every(p => p.state === PieceState.Finished)) {
        currentPlayer.hasFinished = true;
        const activePlayers = gameState.players.filter(p => !p.isRemoved && !p.hasFinished);
        if (activePlayers.length <= 1) {
            gameState.winner = currentPlayer;
            gameState.gameStatus = GameStatus.Finished;
            gameState.message = `${currentPlayer.name} wins the game!`;
            gameState.turn_history.push({ description: `Game finished. Winner: ${currentPlayer.name}` });
        } else {
             gameState.message = `${currentPlayer.name} has finished!`;
             advanceTurn(gameState);
        }
        return;
    }

    if (gameState.diceValue === 6 || capturedPiece) {
        gameState.diceValue = null;
        gameState.movablePieces = [];
        gameState.message += " Roll again!";
        gameState.turnTimeLeft = TURN_TIME_LIMIT;
    } else {
        advanceTurn(gameState);
    }
}

function handleMissedTurn(gameState) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (!currentPlayer || gameState.gameStatus !== GameStatus.Playing) return;

    currentPlayer.inactiveTurns += 1;
    gameState.message = `${currentPlayer.name} missed their turn.`;
    gameState.turn_history.push({ userId: currentPlayer.playerId, name: currentPlayer.name, description: `missed their turn.` });

    if (currentPlayer.inactiveTurns >= MAX_INACTIVE_TURNS) {
        leaveGame(gameState, currentPlayer.playerId);
    } else {
        advanceTurn(gameState);
    }
}

function handlePlayerDisconnect(gameState, playerId) {
    const player = gameState.players.find(p => p.playerId === playerId);
    if (player) {
        player.disconnected = true;
        gameState.message = `${player.name} disconnected.`;
    }
}

function handlePlayerReconnect(gameState, playerId) {
    const player = gameState.players.find(p => p.playerId === playerId);
    if (player) {
        player.disconnected = false;
        gameState.message = `${player.name} reconnected!`;
    }
}

function leaveGame(gameState, playerId) {
    const player = gameState.players.find(p => p.playerId === playerId);
    if (player && !player.isRemoved) {
        player.isRemoved = true;
        player.disconnected = true;
        gameState.message = `${player.name} left the game.`;
        gameState.turn_history.push({ userId: player.playerId, name: player.name, description: `left the game.` });
        
        // Check for win condition
        const activePlayers = gameState.players.filter(p => !p.isRemoved && !p.hasFinished);
        if (activePlayers.length === 1 && gameState.players.length > 1) {
             gameState.winner = activePlayers[0];
             gameState.gameStatus = GameStatus.Finished;
             gameState.message = `${activePlayers[0].name} wins as the opponent left!`;
             gameState.turn_history.push({ description: `Game finished. Winner: ${activePlayers[0].name}` });
        } else if (gameState.players[gameState.currentPlayerIndex].playerId === playerId) {
            advanceTurn(gameState);
        }
    }
}

function sendChatMessage(gameState, playerId, text) {
    const player = gameState.players.find(p => p.playerId === playerId);
    if (!player) return;

    const message = {
        id: uuidv4(),
        game_code: gameState.gameId, // Add game code for DB linking
        playerId,
        name: player.name,
        color: player.color,
        text,
        timestamp: Date.now(),
    };

    if (!gameState.chatMessages) gameState.chatMessages = [];
    gameState.chatMessages.push(message);
    if (gameState.chatMessages.length > 50) gameState.chatMessages.shift();
}

module.exports = {
    createNewGame, addPlayer, startGame,
    initiateRoll, completeRoll, movePiece,
    leaveGame, sendChatMessage, handleMissedTurn,
    handlePlayerDisconnect, handlePlayerReconnect, advanceTurn
};
