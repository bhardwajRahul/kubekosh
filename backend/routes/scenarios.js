'use strict';

const { Router } = require('express');
const { loadScenarios, loadBundles } = require('../lib/cache');
const { injectToTerminal, refreshPrompt } = require('../lib/terminal');
const { getActiveSession, upsertExamProgress } = require('../db/sessions');

/**
 * GET    /api/scenarios                     — list scenarios (optional ?bundle= / ?session=)
 * GET    /api/scenarios/:id                 — full scenario detail
 * POST   /api/scenarios/:id/setup           — run setup_commands
 * POST   /api/scenarios/:id/teardown        — run teardown_commands
 * POST   /api/scenarios/:id/validate        — validate a task scenario
 * POST   /api/scenarios/:id/answer          — submit an MCQ answer
 * POST   /api/scenarios/:id/context         — inject namespace + banner into terminal
 * POST   /api/scenarios/:id/time            — update time_spent_seconds
 */
function createScenariosRouter({ loadProgress, saveProgress, runCommand, checkMatch }) {
  const router = Router();

  // GET /api/scenarios
  router.get('/', (req, res) => {
    const scenarios = loadScenarios();
    const progress  = loadProgress();
    const { bundle, session: sessionId } = req.query;

    // Session-scoped: return only the session's shuffled scenario list
    if (sessionId) {
      const session = getActiveSession();
      let sessionIds = [];
      try { sessionIds = session?.scenario_ids ? JSON.parse(session.scenario_ids) : []; } catch (_) {}

      const list = sessionIds
        .map(id => scenarios.find(s => s.id === id))
        .filter(Boolean)
        .map(s => ({
          id: s.id, title: s.title, category: s.category,
          difficulty: s.difficulty, type: s.type, weight: s.weight,
          progress: progress[s.id] || { status: 'not_started', attempts: 0 },
        }));
      return res.json(list);
    }

    let filtered = scenarios;
    if (bundle) {
      const b = loadBundles().find(x => x.id === bundle);
      if (b) filtered = scenarios.filter(s => b.scenario_ids.includes(s.id));
    }

    const list = filtered.map(s => ({
      id:         s.id,
      title:      s.title,
      category:   s.category,
      difficulty: s.difficulty,
      type:       s.type,
      weight:     s.weight,
      progress:   progress[s.id] || { status: 'not_started', attempts: 0 },
    }));
    res.json(list);
  });

  // GET /api/scenarios/:id — full scenario detail
  router.get('/:id', (req, res) => {
    const scenario = loadScenarios().find(s => s.id === req.params.id);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
    const progress = loadProgress();
    res.json({ ...scenario, progress: progress[scenario.id] || { status: 'not_started', attempts: 0 } });
  });

  // POST /api/scenarios/:id/setup — run setup_commands
  router.post('/:id/setup', async (req, res) => {
    const scenario = loadScenarios().find(s => s.id === req.params.id);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

    const results = [];
    for (const item of (scenario.setup_commands || [])) {
      const result = await runCommand(item.command, 30000);
      results.push({ command: item.command, ...result });
      if (!result.success) {
        console.warn(`Setup command warning: ${item.command} -> ${result.error}`);
      }
    }

    // Mark scenario as in-progress
    const progress = loadProgress();
    if (!progress[scenario.id] || progress[scenario.id].status === 'not_started') {
      progress[scenario.id] = {
        ...progress[scenario.id],
        status:     'in_progress',
        attempts:   progress[scenario.id]?.attempts || 0,
        started_at: progress[scenario.id]?.started_at || new Date().toISOString(),
      };
      saveProgress(progress);
    }

    res.json({ setup_results: results });
  });

  // POST /api/scenarios/:id/teardown — run teardown_commands
  router.post('/:id/teardown', async (req, res) => {
    const scenario = loadScenarios().find(s => s.id === req.params.id);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

    const results = [];
    for (const item of (scenario.teardown_commands || [])) {
      const result = await runCommand(item.command, 30000);
      results.push({ command: item.command, ...result });
    }
    res.json({ ok: true, results });
  });

  // POST /api/scenarios/:id/validate — validate a task scenario
  router.post('/:id/validate', async (req, res) => {
    const scenario = loadScenarios().find(s => s.id === req.params.id);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
    if (scenario.type !== 'task') return res.status(400).json({ error: 'Not a task scenario' });

    const checks  = [];
    let allPassed = true;

    for (const check of (scenario.validation?.commands || [])) {
      const result = await runCommand(check.command, 5000);

      // Prefer stdout. Suppress Kubernetes API server errors (print to stderr, nothing to stdout)
      // so the check fails cleanly rather than matching error text.
      const isKubectlApiError = result.error &&
        /^Error from server|^error:|^Error:/i.test(result.error.trim());
      const actual = result.output || (isKubectlApiError ? '' : result.error) || '';
      const passed = checkMatch(actual, check.expected_output, check.match);

      checks.push({
        description: check.description,
        command:     check.command,
        expected:    check.expected_output,
        match:       check.match || 'exact',
        actual,
        passed,
      });
      if (!passed) allPassed = false;
    }

    // Update global practice progress
    const progress = loadProgress();
    const prev     = progress[scenario.id] || { attempts: 0 };
    progress[scenario.id] = {
      ...prev,
      status:         allPassed ? 'completed' : 'in_progress',
      attempts:       (prev.attempts || 0) + 1,
      last_validated: new Date().toISOString(),
      completed_at:   allPassed ? new Date().toISOString() : prev.completed_at,
    };
    saveProgress(progress);

    // Mirror result into exam_progress if there's an active session
    const activeSession = getActiveSession();
    if (activeSession) {
      upsertExamProgress(activeSession.id, scenario.id, allPassed ? 'completed' : 'in_progress');
    }

    res.json({ passed: allPassed, checks, attempts: progress[scenario.id].attempts });
  });

  // POST /api/scenarios/:id/answer — submit MCQ answer
  router.post('/:id/answer', (req, res) => {
    const { selected } = req.body;
    const scenario     = loadScenarios().find(s => s.id === req.params.id);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
    if (scenario.type !== 'mcq') return res.status(400).json({ error: 'Not an MCQ scenario' });

    const correct  = selected === scenario.correct_option;
    const progress = loadProgress();
    const prev     = progress[scenario.id] || { attempts: 0 };

    progress[scenario.id] = {
      ...prev,
      status:         correct ? 'completed' : 'in_progress',
      attempts:       (prev.attempts || 0) + 1,
      last_answer:    selected,
      last_validated: new Date().toISOString(),
      completed_at:   correct ? new Date().toISOString() : prev.completed_at,
    };
    saveProgress(progress);

    // Mirror result into exam_progress if there's an active session
    const activeSession = getActiveSession();
    if (activeSession) {
      upsertExamProgress(activeSession.id, scenario.id, correct ? 'completed' : 'in_progress');
    }

    res.json({
      correct,
      correct_option: scenario.correct_option,
      explanation:    scenario.explanation,
      attempts:       progress[scenario.id].attempts,
    });
  });

  // POST /api/scenarios/:id/context — inject namespace + banner into active terminals
  router.post('/:id/context', async (req, res) => {
    const scenario = loadScenarios().find(s => s.id === req.params.id);
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

    const ns          = scenario.default_namespace || 'default';
    const clearScreen = '\x1b[2J\x1b[3J\x1b[H';
    const line        = '\u2500'.repeat(54);
    const banner      = [
      `\x1b[2m# ${line}\x1b[0m\r\n`,
      `\x1b[1m\x1b[36m\u2388  Scenario : \x1b[0m\x1b[1m\x1b[97m${scenario.title}\x1b[0m\r\n`,
      `\x1b[2m   Namespace: \x1b[0m\x1b[33m${ns}\x1b[0m`,
      `  \x1b[2mDifficulty: \x1b[0m${scenario.difficulty === 'Easy' ? '\x1b[32m' : scenario.difficulty === 'Hard' ? '\x1b[31m' : '\x1b[33m'}${scenario.difficulty}\x1b[0m\r\n`,
      `\x1b[2m# ${line}\x1b[0m\r\n`,
    ].join('');

    await runCommand(`kubectl config set-context --current --namespace=${ns}`, 5000);
    injectToTerminal(clearScreen + banner);
    refreshPrompt(80);

    res.json({ ok: true, namespace: ns });
  });

  // POST /api/scenarios/:id/time — update time spent on a scenario
  router.post('/:id/time', (req, res) => {
    const { time_spent_seconds } = req.body;
    if (typeof time_spent_seconds !== 'number') {
      return res.status(400).json({ error: 'Invalid time_spent_seconds' });
    }

    const activeSession = getActiveSession();
    if (!activeSession) return res.json({ ok: true, message: 'No active session' });

    const progress = loadProgress();
    if (!progress[req.params.id]) {
      progress[req.params.id] = {
        status:             'in_progress',
        attempts:           0,
        started_at:         new Date().toISOString(),
        time_spent_seconds: 0,
      };
    } else if (!progress[req.params.id].started_at) {
      progress[req.params.id].started_at = new Date().toISOString();
    }
    progress[req.params.id].time_spent_seconds = time_spent_seconds;
    saveProgress(progress);

    res.json({ ok: true });
  });

  return router;
}

module.exports = { createScenariosRouter };
