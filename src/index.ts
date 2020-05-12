import Git from 'nodegit'
import { addMonths, fromUnixTime } from 'date-fns'

import authors from '../config/authors.json'

type Role = 'backend' | 'frontend'

const FRONTEND_LABEL = 'client'
const BACKEND_LABEL = 'server'

const tail = <T>(arr: T[]): T | undefined => arr[arr.length - 1]

const randomSelect = (arr: any[]) => arr[(Math.random() * arr.length) | 0]

const getRandomAuthor = (role?: Role) => {
  if (!role) {
    return randomSelect(authors)
  }

  return randomSelect(authors.filter((author) => author.role === role))
}

const getCommitFiles = (c: Git.Commit) =>
  c
    .getDiff()
    .then((diff) =>
      Promise.all(
        [...diff.values()].map((d) => {
          return d.patches().then((p) => [...p.values()].map((p) => p.newFile().path()))
        }),
      ),
    )
    .then((v) => v[0])

const determineAuthorForCommit = async (c: Git.Commit) => {
  const commitFiles = await getCommitFiles(c)
  const frontendChangesAmount = commitFiles.filter((path) => path.includes(FRONTEND_LABEL)).length
  const backendChangesAmount = commitFiles.filter((path) => path.includes(BACKEND_LABEL)).length

  if (backendChangesAmount > frontendChangesAmount) {
    return getRandomAuthor('backend')
  } else if (frontendChangesAmount > backendChangesAmount) {
    return getRandomAuthor('frontend')
  } else {
    return getRandomAuthor()
  }
}

const operateTime = (unixTime: number) => {
  return (addMonths(fromUnixTime(unixTime), 6).valueOf() / 1000) | 0
}

type CommitStat = {
  author: string
  time: Date
}

type CommitStats = {
  id: string
  old: CommitStat
  new: CommitStat
}

type Opts = {
  branch?: string
  changeTime?: boolean
  keepAuthor?: boolean
}

const run = async (repositoryName: string, options: Opts = {}) => {
  const { branch: branchName = 'master', changeTime = false, keepAuthor = false } = options

  const repo = await Git.Repository.open(repositoryName)

  console.log(
    await repo
      .getBranch(branchName)
      .then((b) => b.resolve())
      .then((r) => r.toString()),
  )

  // Create a walker to find all commits
  const walker = Git.Revwalk.create(repo)

  let originalBranch: string | null = null
  try {
    originalBranch = await repo
      .getBranch(branchName)
      .then((b) => b.resolve())
      .then((r) => r.toString())
  } catch (err) {
    console.log(`Could not find specified branch, trying to use origin/${branchName}`)
    console.error(err)
  }

  if (!originalBranch) {
    try {
      originalBranch = await repo
        .getBranch(`origin/${branchName}`)
        .then((b) => b.resolve())
        .then((r) => r.toString())
    } catch (err) {
      console.error(err)
    }
  }

  if (!originalBranch) {
    console.log(`Could not find branch "${branchName}", exit...`)
    return
  }

  walker.pushRef(originalBranch)

  const [firstCommit, ...commits]: Git.Commit[] = (
    await walker.getCommitsUntil(() => true)
  ).reverse()

  const newBranchName = `recommited/${branchName}`
  let newBranch: Git.Reference

  console.log(`Creating branch "${newBranchName}"...`)
  try {
    newBranch = await repo.createBranch(newBranchName, firstCommit, true)
  } catch (err) {
    console.log(`Re-creating "${newBranchName}"...`)

    await (await repo.getBranch(newBranchName)).delete()
    newBranch = await repo.createBranch(newBranchName, firstCommit, true)
  }

  if (!newBranch) {
    return
  }

  repo.checkoutBranch(newBranch)

  // Amend the first commit
  const newFirstCommit = await (async (c) => {
    const author = await determineAuthorForCommit(c)

    const authorTime = changeTime ? operateTime(c.author().when().time()) : c.author().when().time()
    const commiterTime = changeTime
      ? operateTime(c.committer().when().time())
      : c.committer().when().time()

    const authorSignature = keepAuthor
      ? c.author()
      : Git.Signature.create(author.name, author.email, authorTime, c.author().when().offset())

    const commiterSignature = keepAuthor
      ? c.committer()
      : Git.Signature.create(author.name, author.email, commiterTime, c.committer().when().offset())

    const newCommit = await c.amend(
      'HEAD',
      authorSignature,
      commiterSignature,
      'UTF-8',
      c.message(),
      await c.getTree(),
    )

    console.log('Amended the first commit...')

    return {
      id: newCommit.tostrS(),
      old: {
        author: c.author().name(),
        time: fromUnixTime(c.author().when().time()),
      },
      new: {
        author: authorSignature.name(),
        time: fromUnixTime(authorSignature.when().time()),
      },
    }
  })(firstCommit)

  const { commits: newCommits } = await commits.reduce(async (acc, c) => {
    const { commits } = await acc

    const author = await determineAuthorForCommit(c)

    const authorTime = changeTime ? operateTime(c.author().when().time()) : c.author().when().time()
    const commiterTime = changeTime
      ? operateTime(c.committer().when().time())
      : c.committer().when().time()

    const authorSignature = keepAuthor
      ? c.author()
      : Git.Signature.create(author.name, author.email, authorTime, c.author().when().offset())

    const commiterSignature = keepAuthor
      ? c.committer()
      : Git.Signature.create(author.name, author.email, commiterTime, c.committer().when().offset())

    try {
      const lastCommit = tail(commits)

      const currentCommit = lastCommit
        ? await repo.getCommit(lastCommit.id)
        : await repo.getHeadCommit()

      const newCommit = await repo.createCommit(
        'HEAD',
        authorSignature,
        commiterSignature,
        c.message().replace('MAKHROVYI', 'AnotherOneProject'),
        await c.getTree(),
        [currentCommit],
      )

      const commitStats = {
        id: newCommit.tostrS(),
        old: {
          author: c.author().name(),
          time: fromUnixTime(c.author().when().time()),
        },
        new: {
          author: authorSignature.name(),
          time: fromUnixTime(authorSignature.when().time()),
        },
      }

      return { commits: [...commits, commitStats] }
    } catch (err) {
      console.error('Failed to recommit', c.id().tostrS())
      console.error(err)
    }

    return { commits }
  }, Promise.resolve({ commits: [] as CommitStats[] }))

  try {
    const modifiedCommits = [newFirstCommit, ...newCommits]

    console.log('Commits modified:', modifiedCommits.length)
    console.log('Commits by authors:')
    const commitsByAuthors = modifiedCommits.reduce(
      (acc, c) => ({
        ...acc,
        old: {
          ...acc.old,
          [c.old.author]: (acc.old[c.old.author] || 0) + 1,
        },
        new: {
          ...acc.new,
          [c.new.author]: (acc.new[c.new.author] || 0) + 1,
        },
      }),
      { old: {}, new: {} } as { old: Record<string, number>; new: Record<string, number> },
    )
    console.log('Previous commiters:')
    console.log(commitsByAuthors.old)
    console.log('New commiters:')
    console.log(commitsByAuthors.new)
  } catch (err) {
    console.log('Failed to modify commits')
    console.log(err)
  }
}

run('./repo', { changeTime: false, keepAuthor: true, branch: 'result' })
