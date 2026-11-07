const fs = require('fs');

/**
 * Prunes the oldest seasons from the database if the total number of seasons exceeds maxSeasons.
 * Deletes records chronologically based on 'seasons.id' across all related tables:
 * - seasons
 * - fixtures
 * - league_standings
 * - h2h_records
 * - live_predictions
 * 
 * @param {object} db - An active better-sqlite3 database connection.
 * @param {number} maxSeasons - The maximum number of seasons allowed in the database. Defaults to 70.
 */
function pruneOldSeasons(db, maxSeasons = 70) {
    if (!db) {
        console.error('❌ Error: Database connection is required for pruning.');
        return;
    }

    try {
        // Retrieve seasons sorted chronologically by ID (older seasons have smaller IDs)
        const seasons = db.prepare('SELECT season_name, id FROM seasons ORDER BY id ASC').all();
        
        if (seasons.length > maxSeasons) {
            const deleteCount = seasons.length - maxSeasons;
            const toDelete = seasons.slice(0, deleteCount);
            
            console.log(`🧹 [DB Cleaner] Total seasons (${seasons.length}) exceeds the limit of ${maxSeasons}.`);
            console.log(`🧹 [DB Cleaner] Pruning the oldest ${deleteCount} season(s)...`);

            // Execute deletions in a transaction for atomicity and high performance
            const deleteTransaction = db.transaction((seasonsToDelete) => {
                const deleteSeason = db.prepare('DELETE FROM seasons WHERE season_name = ?');
                const deleteFixtures = db.prepare('DELETE FROM fixtures WHERE season_name = ?');
                const deleteStandings = db.prepare('DELETE FROM league_standings WHERE season_name = ?');
                const deleteH2H = db.prepare('DELETE FROM h2h_records WHERE season_name = ?');
                const deleteLivePred = db.prepare('DELETE FROM live_predictions WHERE season_name = ?');

                for (const s of seasonsToDelete) {
                    console.log(`  🗑️ Deleting all records for season: "${s.season_name}" (ID: ${s.id})`);
                    
                    const resSeasons = deleteSeason.run(s.season_name);
                    const resFixtures = deleteFixtures.run(s.season_name);
                    const resStandings = deleteStandings.run(s.season_name);
                    const resH2H = deleteH2H.run(s.season_name);
                    
                    let resLivePred = { changes: 0 };
                    try {
                        resLivePred = deleteLivePred.run(s.season_name);
                    } catch (e) {
                        // ignore error if live_predictions table doesn't exist
                    }

                    console.log(`    ↳ Deleted from seasons (${resSeasons.changes}), fixtures (${resFixtures.changes}), standings (${resStandings.changes}), H2H (${resH2H.changes}), live_pred (${resLivePred.changes})`);
                }
            });

            deleteTransaction(toDelete);
            console.log(`✅ [DB Cleaner] Successfully pruned ${deleteCount} old season(s).`);
        } else {
            console.log(`📊 [DB Cleaner] Total seasons: ${seasons.length}/${maxSeasons}. No pruning needed.`);
        }
    } catch (error) {
        console.error('❌ [DB Cleaner] Error occurred while pruning old seasons:', error);
    }
}

module.exports = {
    pruneOldSeasons
};
