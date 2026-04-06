import { syncGumroadResourceSubscriptions } from "../src/payments/gumroadResourceSubscriptions.js";

async function main() {
  const result = await syncGumroadResourceSubscriptions();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
