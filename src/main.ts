import * as core from '@actions/core'
import * as github from '@actions/github'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Octokit = ReturnType<typeof github.getOctokit>

type WorkflowRunStatus = 'queued' | 'in_progress' | 'waiting' | 'requested' | 'pending'

type WorkflowRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | null

type JobConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Return true when the conclusion indicates a non-successful terminal state. */
function isFailedConclusion(conclusion: WorkflowRunConclusion | JobConclusion): boolean {
  return conclusion !== null && conclusion !== 'success' && conclusion !== 'neutral' && conclusion !== 'skipped'
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

/** Resolve a workflow file name (e.g. "ci.yml") to its numeric ID. */
async function resolveWorkflowId(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowRef: string,
): Promise<number> {
  const numeric = parseInt(workflowRef, 10)
  if (!isNaN(numeric)) return numeric

  const { data } = await octokit.rest.actions.getWorkflow({ owner, repo, workflow_id: workflowRef })
  return data.id
}

/** Fetch the first page of workflow runs that are currently active (queued / in_progress / waiting). */
async function fetchActiveRuns(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowId: number,
  branch: string,
): Promise<{ id: number; run_number: number; status: string; conclusion: WorkflowRunConclusion }[]> {
  const activeStatuses: WorkflowRunStatus[] = ['queued', 'in_progress', 'waiting', 'requested', 'pending']

  const results: Awaited<ReturnType<typeof fetchActiveRuns>> = []

  for (const status of activeStatuses) {
    let page = 1
    while (true) {
      const { data } = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowId,
        branch: branch || undefined,
        status,
        per_page: 100,
        page,
      })
      const runs = data.workflow_runs as Array<{
        id: number
        run_number: number
        status: string
        conclusion: WorkflowRunConclusion
      }>
      results.push(...runs)
      if (runs.length < 100) break
      page++
    }
  }

  return results
}

/** Fetch jobs for a given run and return info about the named job (if found). */
async function fetchJob(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  jobName: string,
): Promise<{ id: number; status: string; conclusion: JobConclusion; name: string } | null> {
  let page = 1
  while (true) {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      per_page: 100,
      page,
    })
    const jobs = data.jobs as Array<{ id: number; status: string; conclusion: JobConclusion; name: string }>
    const match = jobs.find((j) => j.name === jobName)
    if (match) return match
    if (jobs.length < 100) break
    page++
  }
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  // --- Inputs ---------------------------------------------------------------
  const token = core.getInput('token', { required: true })
  const workflowInput = core.getInput('workflow').trim()
  const jobInput = core.getInput('job').trim()
  const branchInput = core.getInput('run-on-branch').trim()
  const pollIntervalSec = parseInt(core.getInput('poll-interval') || '10', 10)
  const timeoutSec = parseInt(core.getInput('timeout') || '600', 10)
  const failOnPrecedingFailure = core.getInput('fail-on-preceding-run-failure').trim().toLowerCase() === 'true'

  const pollInterval = pollIntervalSec * 1000
  const timeoutMs = timeoutSec * 1000

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const currentRunId = github.context.runId
  const currentRunNumber = github.context.runNumber

  // --- Resolve current run info --------------------------------------------
  const { data: currentRun } = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: currentRunId,
  })

  const branch = branchInput || currentRun.head_branch || ''
  const currentWorkflowId = currentRun.workflow_id

  // --- Resolve target workflow ID ------------------------------------------
  let targetWorkflowId: number
  if (workflowInput) {
    targetWorkflowId = await resolveWorkflowId(octokit, owner, repo, workflowInput)
  } else {
    targetWorkflowId = currentWorkflowId
  }

  core.info(`Repository  : ${owner}/${repo}`)
  core.info(`Branch      : ${branch || '(any)'}`)
  core.info(`Workflow ID : ${targetWorkflowId}`)
  core.info(`Job filter  : ${jobInput || '(entire run)'}`)
  core.info(`Current run : #${currentRunNumber} (ID: ${currentRunId})`)
  core.info(`Poll interval  : ${pollIntervalSec}s`)
  core.info(`Timeout        : ${timeoutSec}s`)
  core.info(`Fail on preceding failure: ${failOnPrecedingFailure}`)
  core.info('─'.repeat(60))

  // --- Polling loop ---------------------------------------------------------
  const deadline = Date.now() + timeoutMs

  while (true) {
    if (Date.now() > deadline) {
      core.setFailed(
        `Timeout: preceding workflow run(s) did not complete within ${timeoutSec} second(s).`,
      )
      return
    }

    const activeRuns = await fetchActiveRuns(octokit, owner, repo, targetWorkflowId, branch)

    // Only care about runs that were triggered *before* the current run
    const precedingActiveRuns = activeRuns.filter((r) => r.run_number < currentRunNumber)

    if (precedingActiveRuns.length === 0) {
      core.info('No preceding active runs found – proceeding.')
      break
    }

    if (!jobInput) {
      // ---- Waiting for whole run -------------------------------------------
      core.info(
        `Waiting for ${precedingActiveRuns.length} preceding run(s): ` +
          precedingActiveRuns.map((r) => `#${r.run_number}`).join(', '),
      )
    } else {
      // ---- Waiting for a specific job inside each preceding run ------------
      // Check each preceding run for the target job status
      const stillWaiting: number[] = []

      for (const precedingRun of precedingActiveRuns) {
        const job = await fetchJob(octokit, owner, repo, precedingRun.id, jobInput)

        if (!job) {
          // Job not yet scheduled – treat the run as still active
          core.info(`Run #${precedingRun.run_number}: job '${jobInput}' not yet found – waiting.`)
          stillWaiting.push(precedingRun.run_number)
          continue
        }

        const jobFinished = job.status === 'completed'

        if (!jobFinished) {
          core.info(`Run #${precedingRun.run_number}: job '${jobInput}' is '${job.status}' – waiting.`)
          stillWaiting.push(precedingRun.run_number)
          continue
        }

        // Job finished
        if (failOnPrecedingFailure && isFailedConclusion(job.conclusion)) {
          core.setFailed(
            `Preceding run #${precedingRun.run_number} job '${jobInput}' finished with conclusion '${job.conclusion}'.`,
          )
          return
        }

        core.info(
          `Run #${precedingRun.run_number}: job '${jobInput}' finished with conclusion '${job.conclusion}'.`,
        )
      }

      if (stillWaiting.length === 0) {
        core.info(`All preceding runs' job '${jobInput}' have completed – proceeding.`)
        break
      }

      core.info(`Still waiting for run(s): ${stillWaiting.map((n) => `#${n}`).join(', ')}`)
    }

    await sleep(pollInterval)
  }

  // --- Final check: inspect concluded preceding runs if fail-on-failure is on
  if (failOnPrecedingFailure && !jobInput) {
    // Fetch recently completed runs (look back up to 200 runs to find preceding ones)
    const { data: recentData } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: targetWorkflowId,
      branch: branch || undefined,
      per_page: 100,
    })

    const recentRuns = recentData.workflow_runs as Array<{
      run_number: number
      status: string
      conclusion: WorkflowRunConclusion
    }>

    const failedPreceding = recentRuns.filter(
      (r) => r.run_number < currentRunNumber && r.status === 'completed' && isFailedConclusion(r.conclusion),
    )

    if (failedPreceding.length > 0) {
      const summary = failedPreceding
        .map((r) => `#${r.run_number} (${r.conclusion})`)
        .join(', ')
      core.warning(`Preceding run(s) finished with failure: ${summary}`)
      // Note: we only warn here because the runs already completed; the option
      // `fail-on-preceding-run-failure` is primarily meaningful for blocking logic.
    }
  }

  core.info('✓ Workflow order ensured – proceeding with current run.')
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
