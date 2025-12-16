const fs = require('fs');
const path = require('path');

const usersFile = path.join(__dirname, '.users.json');
const tokensFile = path.join(__dirname, '.tokens.json');

// Read the current users and tokens
let users = {};
let tokens = {};

try {
  users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
} catch (err) {
  console.error('Error reading files:', err);
  process.exit(1);
}

const email = '11danielyue@gmail.com';
const userId = 'spotify_1213022391';

// Update user record
if (users[email]) {
  console.log(`Disconnecting user: ${email}`);

  // Clear userId and set connectedPlatforms to false
  users[email].userId = null;
  if (!users[email].connectedPlatforms) {
    users[email].connectedPlatforms = {};
  }
  users[email].connectedPlatforms.spotify = false;
  users[email].connectedPlatforms.apple = false;

  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
  console.log('User disconnected in .users.json');
}

// Delete tokens
if (tokens[userId]) {
  console.log(`Deleting tokens for userId: ${userId}`);
  delete tokens[userId];
  fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
  console.log('Tokens deleted from .tokens.json');
}

console.log('\nDone! The user must now reconnect their Spotify account.');
console.log('When they reconnect, they will be prompted to grant the user-top-read permission.');
