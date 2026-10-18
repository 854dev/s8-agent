type Props = {
  comment: string
  onCommentChange: (comment: string) => void
  onSubmit: () => void
  managerReviewed: boolean
  busy: boolean
  pending: boolean
}

export default function CompletionReviewForm({ comment, onCommentChange, onSubmit, managerReviewed, busy, pending }: Props) {
  return <form className="pm-completion-form" aria-label="작업 완료 검토" onSubmit={event => {
    event.preventDefault()
    if (managerReviewed && !busy && !pending) onSubmit()
  }}>
    <h4>검토의견과 완료</h4>
    <label htmlFor="pm-completion-comment">검토의견 (선택)</label>
    <textarea id="pm-completion-comment" rows={4} maxLength={6000} value={comment} disabled={busy || pending}
      placeholder="수정·보완할 내용이나 결과에 대한 의견을 남겨주세요."
      onChange={event => onCommentChange(event.target.value)} />
    <p className="pm-hint">제출하면 이 작업을 완료하고 의견을 매니저에게 전달합니다. 매니저가 추가 작업이 필요한지 판단하며, 새 작업 실행은 별도로 승인합니다. 의견 없이 완료할 수도 있습니다.</p>
    {!managerReviewed && <p>매니저의 결과 검토를 기다리고 있습니다.</p>}
    <button disabled={busy || !managerReviewed || pending} className="pm-primary">검토의견 제출 · 작업 완료</button>
  </form>
}
