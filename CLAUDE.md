@AGENTS.md

## Claude Code 向け補足

- スライスは `/slice <ID>`（`.claude/skills/slice/SKILL.md`）で進める。並列で進めるときは、スライスごとに別のセッションと worktree を使う。
- 見た目の判断は、`artifacts/screens/*.png` を Read で開くか、デスクトップアプリの内蔵ブラウザで `pnpm dev` のページを開いて確かめる。
- レビューは `.claude/agents/reviewer.md`（新しい目で設計書と照合する）に頼む。自分で書いたものを自分だけで承認しない。
- 設計書の正本（claude.ai のドキュメント）は docs ツールで読める。読めない環境では `docs/design-snapshot.md` を使う。
