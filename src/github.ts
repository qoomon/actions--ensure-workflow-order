import * as github from '@actions/github'

export type Octokit = ReturnType<typeof github.getOctokit>

type WorkflowRun = Awaited<ReturnType<Octokit['rest']['actions']['listWorkflowRuns']>>['data']['workflow_runs'][number]

export async function fetchActiveRuns(octokit: Octokit, owner: string, repo: string, workflowId: number, branch: string): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = []
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
