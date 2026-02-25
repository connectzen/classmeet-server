require('dotenv').config();
const { createClient } = require('@insforge/sdk');
const { query } = require('./db');

const insforge = createClient({
    baseUrl: process.env.INSFORGE_BASE_URL,
    anonKey: process.env.INSFORGE_ANON_KEY,
});

async function cleanupOrphanedRooms() {
    console.log('[Cleanup] Starting cleanup of orphaned permanent class rooms...\n');

    try {
        // 1. Get all room IDs from teacher_sessions
        const { rows: teacherRooms } = await query(
            'SELECT DISTINCT room_id FROM teacher_sessions'
        );
        const teacherRoomIds = new Set(teacherRooms.map(r => r.room_id));
        console.log(`[Cleanup] Found ${teacherRoomIds.size} teacher session rooms`);

        // 2. Get all room IDs from admin_meetings
        const { rows: adminRooms } = await query(
            'SELECT DISTINCT room_id FROM admin_meetings'
        );
        const adminRoomIds = new Set(adminRooms.map(r => r.room_id));
        console.log(`[Cleanup] Found ${adminRoomIds.size} admin meeting rooms`);

        // 3. Combine into one set of valid room IDs
        const validRoomIds = new Set([...teacherRoomIds, ...adminRoomIds]);
        console.log(`[Cleanup] Total valid rooms to keep: ${validRoomIds.size}\n`);

        // 4. Get all rooms from InsForge
        const { data: allRooms, error: fetchError } = await insforge.database
            .from('rooms')
            .select('id, code, name, host_id, created_at');

        if (fetchError) {
            console.error('[Cleanup] Error fetching rooms from InsForge:', fetchError.message);
            return;
        }

        console.log(`[Cleanup] Total rooms in InsForge: ${allRooms?.length || 0}`);

        // 5. Find orphaned rooms (not in teacher_sessions or admin_meetings)
        const orphanedRooms = (allRooms || []).filter(room => !validRoomIds.has(room.id));
        
        if (orphanedRooms.length === 0) {
            console.log('[Cleanup] ✅ No orphaned rooms found! Database is clean.\n');
            return;
        }

        console.log(`\n[Cleanup] Found ${orphanedRooms.length} orphaned permanent class rooms:\n`);
        orphanedRooms.forEach((room, i) => {
            console.log(`  ${i + 1}. ${room.name} (${room.code}) - ID: ${room.id.substring(0, 8)}...`);
        });

        // 6. Delete orphaned rooms
        console.log(`\n[Cleanup] Deleting ${orphanedRooms.length} orphaned rooms...`);
        
        let successCount = 0;
        let errorCount = 0;

        for (const room of orphanedRooms) {
            const { error: deleteError } = await insforge.database
                .from('rooms')
                .delete()
                .eq('id', room.id);

            if (deleteError) {
                console.error(`  ❌ Failed to delete ${room.code}: ${deleteError.message}`);
                errorCount++;
            } else {
                console.log(`  ✅ Deleted ${room.code} (${room.name})`);
                successCount++;
            }
        }

        console.log(`\n[Cleanup] ✅ Cleanup complete!`);
        console.log(`  - Successfully deleted: ${successCount} rooms`);
        console.log(`  - Failed: ${errorCount} rooms`);
        console.log(`  - Remaining valid rooms: ${validRoomIds.size}\n`);

    } catch (err) {
        console.error('[Cleanup] Unexpected error:', err.message);
    } finally {
        process.exit(0);
    }
}

cleanupOrphanedRooms();
