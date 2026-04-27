import * as core from '@actions/core'
import * as github from '@actions/github'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Octokit = ReturnType<typeof github.getOctokit>

type WorkflowRunStatus = 'queued' | 'in_progress' | 'waiting'

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

/** Return the start time of a workflow run in milliseconds. */
function getRunStartTime(run: { run_started_at?: string | null; created_at: string }): number {
  return run.run_started_at
    ? new Date(run.run_started_at).getTime()
    : new Date(run.created_at).getTime()
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
): Promise<{ id: number; run_number: number; status: string; conclusion: WorkflowRunConclusion; run_started_at: string | null; created_at: string }[]> {
  const activeStatuses: WorkflowRunStatus[] = ['queued', 'in_progress', 'waiting']

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
        run_started_at: string | null
        created_at: string
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

  if (isNaN(pollIntervalSec) || pollIntervalSec <= 0) {
    core.setFailed(`Invalid poll-interval: '${core.getInput('poll-interval')}'. Must be a positive integer.`)
    return
  }
  if (isNaN(timeoutSec) || timeoutSec <= 0) {
    core.setFailed(`Invalid timeout: '${core.getInput('timeout')}'. Must be a positive integer.`)
    return
  }

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

  // --- Resolve branch -------------------------------------------------------
  let branch: string
  if (branchInput) {
    branch = branchInput
  } else if (currentRun.head_branch) {
    branch = currentRun.head_branch
  } else {
    const ref = github.context.ref
    if (ref.startsWith('refs/heads/')) {
      branch = ref.slice('refs/heads/'.length)
    } else {
      core.setFailed(
        `Could not determine the branch for this run (ref: '${ref}'). ` +
          `Please provide the 'run-on-branch' input explicitly.`,
      )
      return
    }
  }

  const currentWorkflowId = currentRun.workflow_id

  // --- Resolve target workflow ID ------------------------------------------
  let targetWorkflowId: number
  if (workflowInput) {
    targetWorkflowId = await resolveWorkflowId(octokit, owner, repo, workflowInput)
  } else {
    targetWorkflowId = currentWorkflowId
  }

  // When the target workflow differs from the current one, run_number is not
  // comparable across workflows. Use run_started_at instead.
  const isSameWorkflow = targetWorkflowId === currentWorkflowId
  const currentRunStartedAt = getRunStartTime(currentRun)

  core.info(`Repository  : ${owner}/${repo}`)
  core.info(`Branch      : ${branch}`)
  core.info(`Workflow ID : ${targetWorkflowId}${isSameWorkflow ? ' (current)' : ' (cross-workflow)'}`)
  core.info(`Job filter  : ${jobInput || '(entire run)'}`)
  core.info(`Current run : #${currentRunNumber} (ID: ${currentRunId})`)
  core.info(`Poll interval  : ${pollIntervalSec}s`)
  core.info(`Timeout        : ${timeoutSec}s`)
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

    // Only care about runs that were triggered *before* the current run.
    // Within the same workflow run_number is a reliable monotonic counter.
    // Across workflows, compare by run_started_at timestamp instead.
    const precedingActiveRuns = activeRuns.filter((r) => {
      if (isSameWorkflow) {
        return r.run_number < currentRunNumber
      }
      const runStartedAt = getRunStartTime(r)
      return runStartedAt < currentRunStartedAt
    })

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

  core.info('✓ Workflow order ensured – proceeding with current run.')
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err))
})
