const fs = require('fs');
const path = require('path');

const tokensFile = path.join(__dirname, '.tokens.json');

// Read the current tokens
let tokens = {};
try {
  const data = fs.readFileSync(tokensFile, 'utf8');
  tokens = JSON.parse(data);
} catch (err) {
  console.error('Error reading tokens file:', err);
  process.exit(1);
}

// Find and delete the token for userId "spotify_1213022391"
const userId = 'spotify_1213022391';

if (tokens[userId]) {
  console.log(`Deleting tokens for userId: ${userId}`);
  delete tokens[userId];

  // Save the updated tokens
  fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
  console.log('Tokens deleted successfully!');
  console.log('The user will need to reconnect their Spotify account on next login.');
} else {
  console.log(`No tokens found for userId: ${userId}`);
}
