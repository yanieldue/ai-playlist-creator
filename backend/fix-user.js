const fs = require('fs');

const usersFile = '.users.json';
const data = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

// Fix the connectedPlatforms for 11danielyue@gmail.com
if (data['11danielyue@gmail.com']) {
  data['11danielyue@gmail.com'].connectedPlatforms = {
    spotify: true,
    apple: false
  };
  console.log('Fixed connectedPlatforms for 11danielyue@gmail.com');
  
  fs.writeFileSync(usersFile, JSON.stringify(data, null, 2));
  console.log('Saved updated user data');
} else {
  console.log('User not found');
}
