#!/usr/bin/env node
/**
 * Fixes the broken "-" dependency in yellow-ts package
 * This runs as a postinstall script to patch the installed package
 */
const fs = require('fs');
const path = require('path');

const yellowTsPackagePath = path.join(__dirname, '..', 'node_modules', 'yellow-ts', 'package.json');

if (fs.existsSync(yellowTsPackagePath)) {
    try {
        const pkg = JSON.parse(fs.readFileSync(yellowTsPackagePath, 'utf8'));

        if (pkg.dependencies && pkg.dependencies['-']) {
            delete pkg.dependencies['-'];
            fs.writeFileSync(yellowTsPackagePath, JSON.stringify(pkg, null, 2));
            console.log('✅ Patched yellow-ts: removed invalid "-" dependency');
        }
    } catch (err) {
        console.warn('⚠️ Could not patch yellow-ts:', err.message);
    }
}

// Also remove the invalid "-" package if it was installed
const dashPackagePath = path.join(__dirname, '..', 'node_modules', '-');
if (fs.existsSync(dashPackagePath)) {
    fs.rmSync(dashPackagePath, { recursive: true, force: true });
    console.log('✅ Removed invalid "-" package from node_modules');
}
