// Test harness only. It never signs or posts an evaluation and refuses nonlocal databases.
import { Store } from "../../server/store";
import { hash } from "../../shared/evaluation";
if (
  process.env.CHAIN_ID !== "31337" ||
  !process.env.DB_PATH?.startsWith("local-")
)
  throw Error("Local test harness only");
const record = JSON.parse(process.argv[2]!);
if (record.executionMode !== "synthetic-test-fixture")
  throw Error("Fixture must be labeled");
const body = JSON.stringify(record);
const store = new Store(process.env.DB_PATH);
store.put(body, "test-harness");
store.enqueue(record.agreementId);
store.db
  .query("UPDATE jobs SET evidence=?,status='posted' WHERE id=?")
  .run(body, record.agreementId);
store.close();
console.log(hash(body));
