import * as core from '@actions/core'
import * as github from '@actions/github'

type Octokit = ReturnType<typeof github.getOctokit>

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const runStartTime = (run: { run_started_at?: string | null; created_at: string }) =>
  new Date(run.run_started_at ?? run.created_at).getTime()

async function resolveWorkflowId(octokit: Octokit, owner: string, repo: string, ref: string) {
  if (/^\d+$/.test(ref)) return Number(ref)
  return (await octokit.rest.actions.getWorkflow({ owner, repo, workflow_id: ref })).data.id
}

async function fetchActiveRuns(octokit: Octokit, owner: string, repo: string, workflowId: number, branch: string) {
  const runs = []
  for (const status of ['queued', 'in_progress', 'waiting'] as const) {
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.actions.listWorkflowRuns({
        owner, repo, workflow_id: workflowId, branch: branch || undefined, status, per_page: 100, page,
      })
      runs.push(...data.workflow_runs)
      if (data.workflow_runs.length < 100) break
    }
  }
  return runs
}

async function findJob(octokit: Octokit, owner: string, repo: string, runId: number, jobName: string) {
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner, repo, run_id: runId, per_page: 100, page,
    })
    const job = data.jobs.find((j: { name: string }) => j.name === jobName)
    if (job) return job
    if (data.jobs.length < 100) return null
  }
}

async function run() {
  const token = core.getInput('token', { required: true })
  const workflowInput = core.getInput('workflow').trim()
  const jobInput = core.getInput('job').trim()
  const branchInput = core.getInput('run-on-branch').trim()
  const pollIntervalSec = parseInt(core.getInput('poll-interval') || '10', 10)
  const timeoutSec = parseInt(core.getInput('timeout') || '600', 10)

  if (isNaN(pollIntervalSec) || pollIntervalSec <= 0)
    return core.setFailed(`Invalid poll-interval: must be a positive integer.`)
  if (isNaN(timeoutSec) || timeoutSec <= 0)
    return core.setFailed(`Invalid timeout: must be a positive integer.`)

  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const { data: currentRun } = await octokit.rest.actions.getWorkflowRun({
    owner, repo, run_id: github.context.runId,
  })

  const ref = github.context.ref
  const branch = branchInput || currentRun.head_branch ||
    (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '')
  if (!branch)
    return core.setFailed(`Could not determine branch (ref: '${ref}'). Please set the 'run-on-branch' input.`)

  const targetWorkflowId = workflowInput
    ? await resolveWorkflowId(octokit, owner, repo, workflowInput)
    : currentRun.workflow_id
  const isSameWorkflow = targetWorkflowId === currentRun.workflow_id
  const currentRunStartedAt = runStartTime(currentRun)

  core.info(`Repository    : ${owner}/${repo}`)
  core.info(`Branch        : ${branch}`)
  core.info(`Workflow      : ${targetWorkflowId}${isSameWorkflow ? '' : ' (cross-workflow)'}`)
  core.info(`Job filter    : ${jobInput || '(entire run)'}`)
  core.info(`Current run   : #${github.context.runNumber} (ID: ${github.context.runId})`)
  core.info(`Poll interval : ${pollIntervalSec}s | Timeout: ${timeoutSec}s`)

  const deadline = Date.now() + timeoutSec * 1000

  while (true) {
    if (Date.now() > deadline)
      return core.setFailed(`Timeout: preceding run(s) did not complete within ${timeoutSec}s.`)

    const activeRuns = await fetchActiveRuns(octokit, owner, repo, targetWorkflowId, branch)
    const precedingRuns = activeRuns.filter((r) =>
      isSameWorkflow ? r.run_number < github.context.runNumber : runStartTime(r) < currentRunStartedAt,
    )

    if (precedingRuns.length === 0) {
      core.info('No preceding active runs – proceeding.')
      break
    }

    if (!jobInput) {
      core.info(`Waiting for preceding run(s): ${precedingRuns.map((r) => `#${r.run_number}`).join(', ')}`)
    } else {
      const stillWaiting: number[] = []
      for (const run of precedingRuns) {
        const job = await findJob(octokit, owner, repo, run.id, jobInput)
        if (!job || job.status !== 'completed') {
          core.info(`Run #${run.run_number}: job '${jobInput}' ${job ? `is '${job.status}'` : 'not yet found'} – waiting.`)
          stillWaiting.push(run.run_number)
        } else {
          core.info(`Run #${run.run_number}: job '${jobInput}' completed (${job.conclusion}).`)
        }
      }
      if (stillWaiting.length === 0) {
        core.info(`All preceding runs' job '${jobInput}' completed – proceeding.`)
        break
      }
      core.info(`Still waiting for: ${stillWaiting.map((n) => `#${n}`).join(', ')}`)
    }

    await sleep(pollIntervalSec * 1000)
  }

  core.info('✓ Workflow order ensured.')
}

run().catch((err: unknown) => core.setFailed(err instanceof Error ? err.message : String(err)))
