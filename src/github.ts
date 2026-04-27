import * as github from '@actions/github'

export type Octokit = ReturnType<typeof github.getOctokit>

export const runStartTime = (run: { run_started_at?: string | null; created_at: string }) =>
  new Date(run.run_started_at ?? run.created_at).getTime()

export async function resolveWorkflowId(octokit: Octokit, owner: string, repo: string, ref: string) {
  if (/^\d+$/.test(ref)) return Number(ref)
  return (await octokit.rest.actions.getWorkflow({ owner, repo, workflow_id: ref })).data.id
}

export async function fetchActiveRuns(octokit: Octokit, owner: string, repo: string, workflowId: number, branch: string) {
  const activeStatuses = new Set(['queued', 'in_progress', 'waiting'])
  const runs = []
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: workflowId, branch: branch || undefined, per_page: 100, page,
    })
    runs.push(
      ...data.workflow_runs.filter((run: { status?: string | null }) =>
        run.status != null && activeStatuses.has(run.status),
      ),
    )
    if (data.workflow_runs.length < 100) break
  }
  return runs
}

export async function findJob(octokit: Octokit, owner: string, repo: string, runId: number, jobName: string) {
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner, repo, run_id: runId, per_page: 100, page,
    })
    const job = data.jobs.find((j: { name: string }) => j.name === jobName)
    if (job) return job
    if (data.jobs.length < 100) return null
  }
}
