import { ensurePrism } from "../../scripts/ensure-prism.mjs";

// Runs once, outside the per-test and per-hook budgets, so the first Prism
// spawn is not also paying for the download.
export default function setup(): void {
  ensurePrism();
}
