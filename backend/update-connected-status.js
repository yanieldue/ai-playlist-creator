const fs = require('fs');
const path = require('path');

const usersFile = path.join(__dirname, '.users.json');

// Read the current users
let users = {};
try {
  const data = fs.readFileSync(usersFile, 'utf8');
  users = JSON.parse(data);
} catch (err) {
  console.error('Error reading users file:', err);
  process.exit(1);
}

// Update connectedPlatforms for "11danielyue@gmail.com"
const email = '11danielyue@gmail.com';

if (users[email]) {
  console.log(`Updating connectedPlatforms for ${email}`);

  if (!users[email].connectedPlatforms) {
    users[email].connectedPlatforms = {};
  }

  users[email].connectedPlatforms.spotify = false;
  users[email].connectedPlatforms.apple = false;

  // Save the updated users
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
  console.log('User updated successfully!');
  console.log('connectedPlatforms.spotify set to false');
} else {
  console.log(`User not found: ${email}`);
}
