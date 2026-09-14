import { installPrism } from "../../scripts/ensure-prism.mjs";

// Runs once, outside the per-test and per-hook budgets, so the first spawn is
// not also paying for the install.
export default function setup(): void {
  installPrism();
}
