import { ensureNodePtyHelpers } from "../lib/node-pty-helpers.mjs";

// node-pty's npm tarball ships prebuilds/*/spawn-helper as mode 0644. Repair
// both package-local and Pi's hoisted npm layout during installation. The
// broker repeats this check at runtime because some package managers skip or
// relocate lifecycle scripts.
const result = ensureNodePtyHelpers();

if (result.fixed > 0) {
  console.log(`ensure-node-pty-helpers: chmod +x on ${result.fixed} spawn-helper file(s)`);
}
