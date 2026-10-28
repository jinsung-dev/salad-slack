import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { ApiError, api } from "../api";

const ERRORS: Record<string, string> = {
  email_domain_not_allowed: "회사 Google 계정으로만 로그인할 수 있습니다.",
  email_not_verified: "인증된 이메일이 있는 Google 계정만 사용할 수 있습니다.",
  account_conflict: "이 이메일은 다른 Google 계정에 연결되어 있습니다. 관리자에게 문의해 주세요.",
  login_expired: "로그인 시간이 지났습니다. 다시 시도해 주세요.",
  oidc_failed: "Google 로그인에 실패했습니다. 다시 시도해 주세요.",
  rate_limited: "시도가 너무 많습니다. 1분 뒤에 다시 시도해 주세요.",
};

const EMAIL_ERRORS: Record<string, string> = {
  invite_for_other_email: "초대받은 이메일 주소를 입력해 주세요.",
  invite_invalid: "초대가 만료되었거나 취소되었습니다. 보낸 사람에게 새 링크를 요청해 주세요.",
  use_provider: "회사 계정은 위의 Google 로그인을 사용해 주세요.",
  email_login_disabled: "이메일 로그인이 꺼져 있습니다. 관리자에게 문의해 주세요.",
  email_send_failed: "메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
  rate_limited: "코드는 1분에 한 번만 받을 수 있습니다. 잠시 후 다시 시도해 주세요.",
  invalid_code: "코드가 맞지 않습니다.",
  code_expired: "코드가 만료되었습니다. 코드를 다시 받아 주세요.",
  invalid_input: "입력한 내용을 확인해 주세요.",
};

const describeError = (err: unknown) => (err instanceof ApiError ? EMAIL_ERRORS[err.code] : undefined) ?? "요청을 처리하지 못했습니다.";

/** A same-origin path, as the server accepts for `returnTo`; anything else is the home page. */
const samePath = (value: string | null) => (value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/");

export function AuthPage() {
  const [params] = useSearchParams();
  const error = params.get("error");
  const returnTo = params.get("returnTo");
  const inviteToken = returnTo?.match(/^\/invite\/([^/?#]+)$/)?.[1];
  const start = `/api/auth/oidc/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;
  const [emailOpen, setEmailOpen] = useState(false);

  return (
    <div className="auth">
      <div className="auth-card">
        <h1>Chatter</h1>
        <p className="muted">{inviteToken ? "초대를 받으려면 로그인하세요." : "Google 계정으로 로그인하세요."}</p>
        {error && <p className="error">{ERRORS[error] ?? "로그인에 실패했습니다."}</p>}
        {/* A full navigation: the provider's pages cannot run inside the app. */}
        <a className="button google" href={start}>
          Google 계정으로 로그인
        </a>
        {emailOpen ? (
          <EmailSignIn inviteToken={inviteToken} returnTo={samePath(returnTo)} />
        ) : (
          <button className="link" onClick={() => setEmailOpen(true)}>
            회사 밖 게스트이신가요? 이메일 코드로 로그인
          </button>
        )}
      </div>
    </div>
  );
}

/** Outside guests: a code mailed to the invited address stands in for the company sign-in. */
function EmailSignIn({ inviteToken, returnTo }: { inviteToken: string | undefined; returnTo: string }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const requestCode = async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const address = email.trim();
    setError(null);
    setBusy(true);
    try {
      await api.startEmailSignIn(address, inviteToken);
      setSentTo(address);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    setError(null);
    setBusy(true);
    try {
      await api.verifyEmailSignIn(sentTo!, String(form.get("code") ?? "").trim(), name || undefined);
      // Reload into the signed-in app at the page that asked for sign-in (e.g. the invite).
      window.location.assign(returnTo);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  if (!sentTo) {
    return (
      <form className="stack email-sign-in" onSubmit={requestCode}>
        <p className="muted hint">
          {inviteToken ? "초대받은 이메일 주소로 6자리 코드를 보내 드립니다." : "게스트로 참여 중인 이메일 주소로 6자리 코드를 보내 드립니다."}
        </p>
        <input type="email" required placeholder="초대받은 이메일 주소" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          코드 받기
        </button>
      </form>
    );
  }

  return (
    <form className="stack email-sign-in" onSubmit={verify}>
      <p className="muted hint">
        {inviteToken ? `${sentTo}(으)로 코드를 보냈습니다.` : `${sentTo}이(가) 게스트 계정이면 코드를 보냈습니다.`} 메일이 안 보이면 스팸함도 확인해
        주세요.
      </p>
      <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required placeholder="6자리 코드" autoFocus />
      {inviteToken && <input name="name" maxLength={80} placeholder="표시할 이름 (처음 한 번만)" />}
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        로그인
      </button>
      <button type="button" className="link" disabled={busy} onClick={() => void requestCode()}>
        코드 다시 받기
      </button>
    </form>
  );
}
