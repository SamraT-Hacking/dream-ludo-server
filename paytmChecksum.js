
// dream-ludo-server/paytmChecksum.js

"use strict";

const crypto = require('crypto');

class PaytmChecksum {

  static encrypt(input, key) {
    const cipher = crypto.createCipheriv('AES-128-CBC', key, PaytmChecksum.iv);
    let encrypted = cipher.update(input, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  static decrypt(encrypted, key) {
    const decipher = crypto.createDecipheriv('AES-128-CBC', key, PaytmChecksum.iv);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  static async generateSignature(params, key) {
    if (typeof params !== "object" && typeof params !== "string") {
      const error = "string or object expected, " + (typeof params) + " given.";
      return Promise.reject(error);
    }
    if (typeof params !== "string") {
      params = PaytmChecksum.getStringByParams(params);
    }
    return PaytmChecksum.generateSignatureByString(params, key);
  }

  static async verifySignature(params, key, checksum) {
    if (typeof params !== "object" && typeof params !== "string") {
      const error = "string or object expected, " + (typeof params) + " given.";
      return Promise.reject(error);
    }
    if (params.hasOwnProperty("CHECKSUMHASH")) {
      delete params.CHECKSUMHASH;
    }
    if (typeof params !== "string") {
      params = PaytmChecksum.getStringByParams(params);
    }
    return PaytmChecksum.verifySignatureByString(params, key, checksum);
  }

  static async generateSignatureByString(params, key) {
    const salt = await PaytmChecksum.generateRandomString(4);
    return PaytmChecksum.calculateChecksum(params, key, salt);
  }

  static verifySignatureByString(params, key, checksum) {
    const paytm_hash = PaytmChecksum.decrypt(checksum, key);
    const salt = paytm_hash.substr(paytm_hash.length - 4);
    return (paytm_hash === PaytmChecksum.calculateHash(params, salt));
  }

  static generateRandomString(length) {
    return new Promise((resolve, reject) => {
      crypto.randomBytes((length * 3.0) / 4.0, (err, buf) => {
        if (!err) {
          const salt = buf.toString("base64");
          resolve(salt);
        } else {
          console.log("error occurred in generating salt");
          reject(err);
        }
      });
    });
  }

  static getStringByParams(params) {
    const data = {};
    Object.keys(params).sort().forEach((key, value) => {
      data[key] = (params[key] !== null && params[key].toLowerCase() !== "null") ? params[key] : "";
    });
    return Object.values(data).join('|');
  }

  static calculateHash(params, salt) {
    const finalString = params + "|" + salt;
    return crypto.createHash('sha256').update(finalString).digest('hex') + salt;
  }

  static calculateChecksum(params, key, salt) {
    const hashString = PaytmChecksum.calculateHash(params, salt);
    return PaytmChecksum.encrypt(hashString, key);
  }
}

PaytmChecksum.iv = '@@@@&&&&####$$$$';
module.exports = PaytmChecksum;
