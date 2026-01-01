/**
 * Test script for Apple Music Service
 * Tests developer token generation and basic search functionality
 */

require('dotenv').config();
const fs = require('fs');
const jwt = require('jsonwebtoken');
const AppleMusicService = require('./services/appleMusicService');

// Generate Apple Music Developer Token
function generateAppleMusicToken() {
  const teamId = process.env.APPLE_MUSIC_TEAM_ID;
  const keyId = process.env.APPLE_MUSIC_KEY_ID;
  const privateKeyPath = process.env.APPLE_MUSIC_PRIVATE_KEY_PATH;

  if (!teamId || !keyId || !privateKeyPath) {
    throw new Error('Missing Apple Music credentials in .env file');
  }

  // Read private key from file
  let privateKey;
  try {
    privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read private key file: ${error.message}`);
  }

  // Generate JWT token
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 15777000; // 6 months (max allowed by Apple)

  try {
    const token = jwt.sign(
      {
        iss: teamId,
        iat: now,
        exp: now + expiresIn,
      },
      privateKey,
      {
        algorithm: 'ES256',
        keyid: keyId,
      }
    );

    return token;
  } catch (error) {
    throw new Error(`Failed to generate JWT token: ${error.message}`);
  }
}

async function testAppleMusicService() {
  console.log('🎵 Testing Apple Music Service\n');
  console.log('='.repeat(50));

  try {
    // Step 1: Generate Developer Token
    console.log('\n1. Generating Apple Music Developer Token...');
    const developerToken = generateAppleMusicToken();
    console.log('✓ Developer token generated successfully');
    console.log(`Token length: ${developerToken.length} characters`);
    console.log(`Token preview: ${developerToken.substring(0, 50)}...`);

    // Step 2: Initialize Apple Music Service
    console.log('\n2. Initializing Apple Music Service...');
    const appleMusicService = new AppleMusicService(developerToken);
    console.log('✓ Service initialized');

    // Step 3: Test Search (doesn't require user token)
    console.log('\n3. Testing search functionality...');
    console.log('Searching for: "Taylor Swift"');

    const searchResults = await appleMusicService.searchTracks('Taylor Swift', 'us', 5);

    if (searchResults.length > 0) {
      console.log(`✓ Found ${searchResults.length} tracks:`);
      searchResults.forEach((track, index) => {
        console.log(`\n   ${index + 1}. ${track.name}`);
        console.log(`      Artist: ${track.artists[0].name}`);
        console.log(`      Album: ${track.album.name}`);
        console.log(`      Duration: ${Math.floor(track.duration_ms / 1000)}s`);
        console.log(`      ID: ${track.id}`);
        console.log(`      URI: ${track.uri}`);
      });
    } else {
      console.log('⚠️  No results found');
    }

    // Step 4: Test finding specific track
    console.log('\n4. Testing track name + artist search...');
    const specificTrack = await appleMusicService.findTrackByNameAndArtist(
      'Anti-Hero',
      'Taylor Swift',
      'us'
    );

    if (specificTrack) {
      console.log('✓ Found specific track:');
      console.log(`   Name: ${specificTrack.name}`);
      console.log(`   Artist: ${specificTrack.artists[0].name}`);
      console.log(`   ID: ${specificTrack.id}`);
    } else {
      console.log('⚠️  Track not found');
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ All tests passed!');
    console.log('\nNote: User-specific operations (playlists, library) require');
    console.log('user authentication and a Music-User-Token.');

  } catch (error) {
    console.error('\n❌ Test failed:');
    console.error(`Error: ${error.message}`);

    if (error.status) {
      console.error(`HTTP Status: ${error.status}`);
    }
    if (error.code) {
      console.error(`Error Code: ${error.code}`);
    }

    console.log('\nTroubleshooting:');
    console.log('1. Check that .env file has correct Apple Music credentials');
    console.log('2. Verify AuthKey.p8 file exists and is readable');
    console.log('3. Ensure APPLE_MUSIC_TEAM_ID and APPLE_MUSIC_KEY_ID match your Apple Developer account');
    console.log('4. Check that the private key format is correct');

    process.exit(1);
  }
}

// Run tests
testAppleMusicService();
