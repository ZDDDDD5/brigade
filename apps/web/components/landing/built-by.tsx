import { formatCount, mergeDate, type ProofNumbers, REPO, REPO_URL } from '@/lib/github-proof'
import o from './built-by.module.css'
import { c, Icon } from './parts'

const cx = (names: string) =>
  names
    .split(' ')
    .map((n) => o[n] ?? n)
    .join(' ')

function proof(numbers: ProofNumbers) {
  const { mergedPrs, totalCommits, recentMerges } = numbers
  return {
    merged: mergedPrs,
    total: totalCommits,
    merges: recentMerges ?? [],
  }
}

/** The repository, as a quiet text link: it backs the claim up rather than asking to be
 * clicked. */
function GithubLink() {
  return (
    <a className={cx('gh')} href={REPO_URL}>
      View on GitHub <Icon name="external" />
    </a>
  )
}

/**
 * Brigade's own team as proof, the way a developer would check it: the claim, the GitHub
 * numbers read at build (lib/github-proof.ts) said as one line under it, and a terminal
 * running the real command that lists the last pull requests merged. A number GitHub did not
 * give back leaves out what needs it; with no merges, there is no terminal.
 */
export function BuiltBy({ numbers }: { numbers: ProofNumbers }) {
  const { merged, total, merges } = proof(numbers)
  const stats = [
    merged !== null && { n: formatCount(merged), l: 'PRs merged' },
    total !== null && { n: formatCount(total), l: 'commits' },
  ].filter((s): s is { n: string; l: string } => Boolean(s))
  return (
    <section className={c('sec')} aria-labelledby="built-title">
      <div className={c('wrap')}>
        <div className={cx('b-head')} data-reveal="stagger">
          <h2 className={c('h2')} id="built-title">
            Brigade is built by Brigade.
          </h2>
          {stats.length > 0 && (
            <p className={cx('b-stats')}>
              {stats.map((s, i) => (
                <span key={s.l}>
                  {i > 0 && ', '}
                  <b>{s.n}</b> {s.l}
                </span>
              ))}{' '}
              on its own.
            </p>
          )}
        </div>
        {merges.length > 0 && (
          <div
            className={cx('b-term')}
            aria-label="Latest merged pull requests"
            data-reveal="pop"
            data-reveal-delay="2"
          >
            <div className={cx('b-bar')}>
              <i></i>
              <i></i>
              <i></i>
              <span>{REPO}</span>
            </div>
            <div className={cx('b-body')}>
              <p className={cx('b-cmd')}>
                <span className={cx('b-ps')}>$</span> gh pr list --state merged --limit{' '}
                {merges.length}
              </p>
              {merges.map((pr) => (
                <a key={pr.number} className={cx('b-line')} href={pr.url}>
                  <span className={cx('b-no')}>#{pr.number}</span>
                  <span className={cx('b-t truncate')}>{pr.title}</span>
                  <span className={cx('b-br truncate')}>{pr.branch ?? 'main'}</span>
                  <time className={cx('b-d')} dateTime={pr.mergedAt}>
                    {mergeDate(pr.mergedAt)}
                  </time>
                </a>
              ))}
              <p className={cx('b-cmd b-cursor')}>
                <span className={cx('b-ps')}>$</span> <span className={cx('b-caret')} />
              </p>
            </div>
          </div>
        )}
        <div className={cx('b-after')} data-reveal data-reveal-delay="3">
          <GithubLink />
        </div>
      </div>
    </section>
  )
}
