/**
 * Test Server Integration
 * Quick test to verify backend can generate tokens and use services
 */

require('dotenv').config();
const PlatformService = require('./services/platformService');
const fs = require('fs');
const jwt = require('jsonwebtoken');

// Same function as in server.js
function generateAppleMusicToken() {
  try {
    const teamId = process.env.APPLE_MUSIC_TEAM_ID;
    const keyId = process.env.APPLE_MUSIC_KEY_ID;
    const privateKeyPath = process.env.APPLE_MUSIC_PRIVATE_KEY_PATH;

    if (teamId && keyId && privateKeyPath) {
      const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = 15777000; // 6 months

      const token = jwt.sign(
        { iss: teamId, iat: now, exp: now + expiresIn },
        privateKey,
        { algorithm: 'ES256', keyid: keyId }
      );

      return token;
    }

    return null;
  } catch (error) {
    console.error('Error generating Apple Music token:', error.message);
    return null;
  }
}

async function testIntegration() {
  console.log('🧪 Testing Server Integration\n');
  console.log('='.repeat(50));

  try {
    // Test 1: Platform Service can detect platforms
    console.log('\n1. Testing Platform Detection...');
    const platformService = new PlatformService();

    const spotifyUserId = 'spotify_abc123';
    const appleUserId = 'apple_music_xyz789';

    const spotifyPlatform = platformService.getPlatform(spotifyUserId);
    const applePlatform = platformService.getPlatform(appleUserId);

    console.log(`✓ Spotify userId "${spotifyUserId}" → platform: ${spotifyPlatform}`);
    console.log(`✓ Apple userId "${appleUserId}" → platform: ${applePlatform}`);

    // Test 2: Can generate developer token
    console.log('\n2. Testing Apple Music Developer Token Generation...');
    const devToken = generateAppleMusicToken();

    if (devToken) {
      console.log('✓ Developer token generated');
      console.log(`  Length: ${devToken.length} characters`);

      // Decode token to verify
      const decoded = jwt.decode(devToken, { complete: true });
      console.log(`  Team ID: ${decoded.payload.iss}`);
      console.log(`  Key ID: ${decoded.header.kid}`);
      console.log(`  Expires: ${new Date(decoded.payload.exp * 1000).toISOString()}`);
    } else {
      throw new Error('Failed to generate developer token');
    }

    // Test 3: Mock search with PlatformService (Apple Music, no user token needed)
    console.log('\n3. Testing PlatformService Search (Apple Music)...');

    const mockTokens = {
      developer_token: devToken,
      access_token: null, // Not needed for catalog search
      storefront: 'us'
    };

    const results = await platformService.searchTracks(
      appleUserId,
      'Billie Eilish',
      mockTokens,
      'us',
      3
    );

    console.log(`✓ Search returned ${results.length} results:`);
    results.forEach((track, i) => {
      console.log(`  ${i + 1}. ${track.name} - ${track.artists[0].name}`);
    });

    console.log('\n' + '='.repeat(50));
    console.log('✅ All integration tests passed!\n');
    console.log('Next steps to test Apple Music OAuth:');
    console.log('1. Start the backend server: npm start');
    console.log('2. Visit http://localhost:3001/api/auth/apple?email=test@example.com');
    console.log('3. Complete Apple Music authorization');
    console.log('4. Check callback receives user music token');

  } catch (error) {
    console.error('\n❌ Integration test failed:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

testIntegration();
