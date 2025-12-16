const sqliteDb = require('./database'); // SQLite database
const postgresDb = require('./database-postgres'); // PostgreSQL database

async function migrate() {
  console.log('Starting migration from SQLite to PostgreSQL...\n');

  try {
    // Initialize PostgreSQL connection
    console.log('Initializing PostgreSQL connection...');
    await postgresDb.initialize();
    console.log('✓ PostgreSQL connected and tables created\n');

    // Get all data from SQLite
    console.log('Fetching data from SQLite...');
    const users = sqliteDb.getAllUsers();
    const tokens = sqliteDb.getAllTokens();
    console.log(`✓ Found ${users.length} users`);
    console.log(`✓ Found ${Object.keys(tokens).length} tokens\n`);

    // Migrate users
    console.log('Migrating users...');
    let usersCount = 0;
    for (const user of users) {
      try {
        await postgresDb.createUser(
          user.email,
          user.password,
          user.platform,
          user.userId
        );

        // Set connected platforms
        if (user.connectedPlatforms) {
          await postgresDb.setConnectedPlatforms(
            user.email,
            user.connectedPlatforms.spotify || false,
            user.connectedPlatforms.apple || false
          );
        }

        usersCount++;
        process.stdout.write(`\r  Migrated ${usersCount}/${users.length} users`);
      } catch (err) {
        console.error(`\n  Failed to migrate user ${user.email}:`, err.message);
      }
    }
    console.log(`\n✓ Migrated ${usersCount} users\n`);

    // Migrate tokens
    console.log('Migrating tokens...');
    let tokensCount = 0;
    const tokenEntries = Object.entries(tokens);
    for (const [userId, token] of tokenEntries) {
      try {
        await postgresDb.setToken(userId, token);
        tokensCount++;
        process.stdout.write(`\r  Migrated ${tokensCount}/${tokenEntries.length} tokens`);
      } catch (err) {
        console.error(`\n  Failed to migrate token for ${userId}:`, err.message);
      }
    }
    console.log(`\n✓ Migrated ${tokensCount} tokens\n`);

    console.log('✅ Migration complete!');
    console.log('\nNext steps:');
    console.log('1. Update your .env file to include DATABASE_URL');
    console.log('2. Update server.js to use database-postgres.js instead of database.js');
    console.log('3. Restart your server');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    // Close connections
    await postgresDb.close();
    process.exit(0);
  }
}

// Run migration
migrate().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
