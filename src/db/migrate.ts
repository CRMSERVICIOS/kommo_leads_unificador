import { closeDb, runMigrations } from "./index";

/** `npm run db:migrate`: aplica schema.sql contra DATABASE_URL y sale. */
runMigrations()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
