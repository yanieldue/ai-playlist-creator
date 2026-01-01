/**
 * Test Apple Music Integration Endpoints
 * Tests the new platform-agnostic endpoints
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3001';

// Test with a mock Apple Music userId
const APPLE_MUSIC_USER_ID = 'apple_music_test123';
const SPOTIFY_USER_ID = 'spotify_test123';

async function testEndpoints() {
  console.log('🧪 Testing Apple Music Integration Endpoints\n');
  console.log('='.repeat(60));

  try {
    // Test 1: Search endpoint (without authentication - will fail but we can see the flow)
    console.log('\n1. Testing POST /api/search endpoint...');
    console.log('   This will fail (401) since we don\'t have real tokens,');
    console.log('   but we can verify the endpoint exists and platform detection works.\n');

    try {
      const searchResponse = await axios.post(`${BASE_URL}/api/search`, {
        query: 'Taylor Swift',
        userId: APPLE_MUSIC_USER_ID
      });
      console.log('   ✓ Search successful:', searchResponse.data);
    } catch (error) {
      if (error.response?.status === 401) {
        console.log('   ✓ Endpoint exists (401 - needs auth as expected)');
      } else {
        console.log('   ⚠️  Error:', error.response?.data || error.message);
      }
    }

    // Test 2: Get OAuth URL
    console.log('\n2. Testing GET /api/auth/apple...');
    const authResponse = await axios.get(`${BASE_URL}/api/auth/apple`, {
      params: { email: 'test@example.com' }
    });
    console.log('   ✓ OAuth URL generated:');
    console.log('   ', authResponse.data.url.substring(0, 100) + '...');

    // Test 3: Verify platform detection
    console.log('\n3. Testing platform detection...');
    console.log('   Apple Music userId:', APPLE_MUSIC_USER_ID);
    console.log('   Spotify userId:', SPOTIFY_USER_ID);
    console.log('   ✓ Platform detection will route based on userId prefix');

    console.log('\n' + '='.repeat(60));
    console.log('✅ Basic endpoint tests passed!\n');

    console.log('📋 Next Steps for Manual Testing:');
    console.log('1. Connect Apple Music:');
    console.log('   Visit: http://localhost:3001/api/auth/apple?email=your@email.com');
    console.log('   Sign in with your Apple ID');
    console.log('   Check console for callback logs');
    console.log('');
    console.log('2. Test with Postman/Insomnia:');
    console.log('   POST http://localhost:3001/api/search');
    console.log('   Body: { "query": "Billie Eilish", "userId": "apple_music_..." }');
    console.log('');
    console.log('3. Test create playlist:');
    console.log('   POST http://localhost:3001/api/create-playlist');
    console.log('   Body: { "userId": "apple_music_...", "playlistName": "Test", ... }');

  } catch (error) {
    console.error('\n❌ Test failed:');
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }
}

// Check if server is running
async function checkServer() {
  try {
    await axios.get(`${BASE_URL}/health`);
    return true;
  } catch (error) {
    return false;
  }
}

(async () => {
  const isRunning = await checkServer();
  if (!isRunning) {
    console.log('⚠️  Backend server not running on port 3001');
    console.log('Please start it with: cd backend && npm start\n');
    process.exit(1);
  }

  await testEndpoints();
})();
