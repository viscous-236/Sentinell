/**
 * Yellow Integration Verification Script
 * 
 * Verifies that all agents are properly bound to Yellow Network
 * according to PROJECT_SPEC.md Section 4.5:
 * "Agents communicate via Yellow state channels"
 * 
 * Checks:
 * 1. ✅ Scout Agent → Yellow (signals published to Yellow)
 * 2. ✅ Validator Agent → Yellow (alerts published to Yellow)
 * 3. ✅ Yellow → RiskEngine (signals/alerts received from Yellow)
 * 4. ✅ RiskEngine → Yellow (decisions published to Yellow)
 * 5. ✅ Yellow → Executor (decisions received from Yellow)
 * 6. ✅ Executor → Yellow (execution results published to Yellow)
 */

import * as fs from 'fs';
import * as path from 'path';

interface VerificationResult {
    component: string;
    check: string;
    status: 'PASS' | 'FAIL' | 'WARNING';
    details: string;
}

const results: VerificationResult[] = [];

function checkFile(filePath: string, patterns: Array<{ name: string; regex: RegExp; required: boolean }>) {
    const absolutePath = path.join(__dirname, filePath);
    
    if (!fs.existsSync(absolutePath)) {
        results.push({
            component: path.basename(filePath),
            check: 'File exists',
            status: 'FAIL',
            details: `File not found: ${filePath}`
        });
        return;
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');

    for (const { name, regex, required } of patterns) {
        const match = regex.test(content);
        
        results.push({
            component: path.basename(filePath),
            check: name,
            status: match ? 'PASS' : (required ? 'FAIL' : 'WARNING'),
            details: match ? 'Found' : 'Not found'
        });
    }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('🔍 YELLOW NETWORK INTEGRATION VERIFICATION');
console.log('   Per PROJECT_SPEC.md Section 4.5:');
console.log('   "Agents communicate via Yellow state channels"');
console.log('═══════════════════════════════════════════════════════════\n');

// 1. Check index.ts - Main entrypoint
console.log('📋 1. Checking Main Entrypoint (index.ts)...\n');
checkFile('./src/index.ts', [
    { name: 'Imports YellowMessageBus', regex: /import.*YellowMessageBus.*from.*yellow\/YellowMessageBus/, required: true },
    { name: 'Imports wireAllAgentsToYellow', regex: /import.*wireAllAgentsToYellow.*from.*yellow\/YellowAgentAdapters/, required: true },
    { name: 'Initializes YellowMessageBus', regex: /yellowMessageBus\s*=\s*new YellowMessageBus/, required: true },
    { name: 'Calls wireAllAgentsToYellow', regex: /wireAllAgentsToYellow\s*\(/, required: true },
    { name: 'Passes all 4 agents', regex: /scout:\s*scoutAgent.*validator:\s*validatorAgent.*riskEngine.*executor:\s*executorAgent/s, required: true },
]);

// 2. Check YellowAgentAdapters.ts
console.log('\n📋 2. Checking Yellow Agent Adapters...\n');
checkFile('./src/shared/yellow/YellowAgentAdapters.ts', [
    { name: 'ScoutYellowAdapter exists', regex: /export class ScoutYellowAdapter/, required: true },
    { name: 'ValidatorYellowAdapter exists', regex: /export class ValidatorYellowAdapter/, required: true },
    { name: 'RiskEngineYellowAdapter exists', regex: /export class RiskEngineYellowAdapter/, required: true },
    { name: 'ExecutorYellowAdapter exists', regex: /export class ExecutorYellowAdapter/, required: true },
    { name: 'Scout publishes to Yellow', regex: /messageBus\.publishSignal/, required: true },
    { name: 'Validator publishes to Yellow', regex: /messageBus\.publishAlert/, required: true },
    { name: 'RiskEngine subscribes to signals', regex: /messageBus\.subscribeToSignals/, required: true },
    { name: 'RiskEngine subscribes to alerts', regex: /messageBus\.subscribeToAlerts/, required: true },
    { name: 'RiskEngine publishes decisions', regex: /messageBus\.publishDecision/, required: true },
    { name: 'Executor subscribes to decisions', regex: /messageBus\.subscribeToDecisions/, required: true },
    { name: 'Executor publishes executions', regex: /messageBus\.publishExecution/, required: true },
]);

// 3. Check RiskEngine.ts - Should have Yellow event listeners
console.log('\n📋 3. Checking Risk Engine Yellow Integration...\n');
checkFile('./src/executor/src/RiskEngine.ts', [
    { name: 'Listens to yellow:signal', regex: /this\.on\(['"]yellow:signal['"]/, required: true },
    { name: 'Listens to yellow:alert', regex: /this\.on\(['"]yellow:alert['"]/, required: true },
    { name: 'Processes signals from Yellow', regex: /yellow:signal.*=>.*ingestScoutEvent/s, required: true },
    { name: 'Processes alerts from Yellow', regex: /yellow:alert.*=>.*ingestValidatorAlert/s, required: true },
]);

// 4. Check Execution.ts - Should have Yellow decision listener
console.log('\n📋 4. Checking Executor Agent Yellow Integration...\n');
checkFile('./src/executor/src/Execution.ts', [
    { name: 'Listens to yellow:decision', regex: /this\.on\(['"]yellow:decision['"]/, required: true },
    { name: 'Executes decisions from Yellow', regex: /yellow:decision.*=>.*executeDecision/s, required: true },
]);

// 5. Check YellowMessageBus.ts
console.log('\n📋 5. Checking Yellow Message Bus Implementation...\n');
checkFile('./src/shared/yellow/YellowMessageBus.ts', [
    { name: 'publishSignal method', regex: /async publishSignal\s*\(/, required: true },
    { name: 'publishAlert method', regex: /async publishAlert\s*\(/, required: true },
    { name: 'publishDecision method', regex: /async publishDecision\s*\(/, required: true },
    { name: 'publishExecution method', regex: /async publishExecution\s*\(/, required: true },
    { name: 'subscribeToSignals method', regex: /subscribeToSignals\s*\(/, required: true },
    { name: 'subscribeToAlerts method', regex: /subscribeToAlerts\s*\(/, required: true },
    { name: 'subscribeToDecisions method', regex: /subscribeToDecisions\s*\(/, required: true },
]);

// Print results
console.log('\n═══════════════════════════════════════════════════════════');
console.log('📊 VERIFICATION RESULTS');
console.log('═══════════════════════════════════════════════════════════\n');

const groupedResults = results.reduce((acc, result) => {
    if (!acc[result.component]) {
        acc[result.component] = [];
    }
    acc[result.component].push(result);
    return acc;
}, {} as Record<string, VerificationResult[]>);

let totalPassed = 0;
let totalFailed = 0;
let totalWarnings = 0;

for (const [component, checks] of Object.entries(groupedResults)) {
    console.log(`📁 ${component}:`);
    for (const check of checks) {
        const emoji = check.status === 'PASS' ? '✅' : check.status === 'FAIL' ? '❌' : '⚠️';
        console.log(`   ${emoji} ${check.check}: ${check.details}`);
        
        if (check.status === 'PASS') totalPassed++;
        else if (check.status === 'FAIL') totalFailed++;
        else totalWarnings++;
    }
    console.log();
}

console.log('═══════════════════════════════════════════════════════════');
console.log(`📊 Summary: ${totalPassed} passed, ${totalFailed} failed, ${totalWarnings} warnings`);
console.log('═══════════════════════════════════════════════════════════\n');

if (totalFailed > 0) {
    console.log('❌ VERIFICATION FAILED');
    console.log('   Some agents are not properly bound to Yellow Network.');
    console.log('   Please review the failed checks above.\n');
    process.exit(1);
} else if (totalWarnings > 0) {
    console.log('⚠️  VERIFICATION PASSED WITH WARNINGS');
    console.log('   All critical checks passed, but some optional features are missing.\n');
} else {
    console.log('✅ VERIFICATION PASSED');
    console.log('   All agents are properly bound to Yellow Network!');
    console.log('   Communication flow per PROJECT_SPEC.md Section 4.5:');
    console.log('   Scout → Yellow → RiskEngine → Yellow → Executor → Yellow\n');
}
