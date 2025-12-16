const fs = require('fs');
const path = require('path');
const db = require('./database');

console.log('Starting migration from JSON files to SQLite database...\n');

// Read JSON files
const usersFile = path.join(__dirname, '.users.json');
const tokensFile = path.join(__dirname, '.tokens.json');

let users = {};
let tokens = {};

try {
  if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    console.log(`Found ${Object.keys(users).length} users in .users.json`);
  }
} catch (err) {
  console.error('Error reading users file:', err.message);
}

try {
  if (fs.existsSync(tokensFile)) {
    tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
    console.log(`Found ${Object.keys(tokens).length} tokens in .tokens.json`);
  }
} catch (err) {
  console.error('Error reading tokens file:', err.message);
}

// Migrate users
console.log('\nMigrating users...');
let usersCount = 0;
for (const email in users) {
  const user = users[email];
  try {
    db.createUser(
      email,
      user.password,
      user.platform,
      user.userId || null
    );

    // Set connected platforms
    if (user.connectedPlatforms) {
      db.setConnectedPlatforms(
        email,
        user.connectedPlatforms.spotify || false,
        user.connectedPlatforms.apple || false
      );
    }

    usersCount++;
  } catch (err) {
    console.error(`Failed to migrate user ${email}:`, err.message);
  }
}
console.log(`✓ Migrated ${usersCount} users`);

// Migrate tokens
console.log('\nMigrating tokens...');
let tokensCount = 0;
for (const userId in tokens) {
  const token = tokens[userId];
  try {
    db.setToken(userId, token);
    tokensCount++;
  } catch (err) {
    console.error(`Failed to migrate token for ${userId}:`, err.message);
  }
}
console.log(`✓ Migrated ${tokensCount} tokens`);

console.log('\n✓ Migration complete!');
console.log('\nYou can now:');
console.log('1. Backup your .users.json and .tokens.json files');
console.log('2. Update server.js to use the database');
console.log('3. Restart your server');
