export const startupMessage = "ExpenseFlow service bootstrap ready.";

export async function main(): Promise<void> {
  console.log(startupMessage);
}

const isDirectRun = process.argv[1] === new URL(import.meta.url).pathname;

if (isDirectRun) {
  await main();
}
