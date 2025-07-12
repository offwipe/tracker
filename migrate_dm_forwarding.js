const db = require('./db');

async function migrateDMForwarding() {
    try {
        console.log('Adding forward_to_dms column to tracked_items table...');
        
        // Add the forward_to_dms column with a default value of false
        await db.query(`
            ALTER TABLE tracked_items 
            ADD COLUMN IF NOT EXISTS forward_to_dms BOOLEAN DEFAULT FALSE
        `);
        
        console.log('✅ Migration completed successfully!');
        console.log('The forward_to_dms column has been added to the tracked_items table.');
        console.log('Users can now use /forward2dms to enable DM forwarding for their tracked items.');
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
    } finally {
        process.exit(0);
    }
}

migrateDMForwarding(); 