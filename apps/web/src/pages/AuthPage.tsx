import { useSearchParams } from "react-router";

const ERRORS: Record<string, string> = {
  email_domain_not_allowed: "회사 Google 계정(@saladlab.co)으로만 로그인할 수 있습니다.",
  email_not_verified: "인증된 이메일이 있는 Google 계정만 사용할 수 있습니다.",
  account_conflict: "이 이메일은 다른 Google 계정에 연결되어 있습니다. 관리자에게 문의해 주세요.",
  login_expired: "로그인 시간이 지났습니다. 다시 시도해 주세요.",
  oidc_failed: "Google 로그인에 실패했습니다. 다시 시도해 주세요.",
  rate_limited: "시도가 너무 많습니다. 1분 뒤에 다시 시도해 주세요.",
};

export function AuthPage() {
  const [params] = useSearchParams();
  const error = params.get("error");

  return (
    <div className="auth">
      <div className="auth-card">
        <h1>Chatter</h1>
        <p className="muted">회사 Google 계정으로 로그인하세요.</p>
        {error && <p className="error">{ERRORS[error] ?? "로그인에 실패했습니다."}</p>}
        {/* A full navigation: the provider's pages cannot run inside the app. */}
        <a className="button google" href="/api/auth/oidc/start">
          Google 계정으로 로그인
        </a>
      </div>
    </div>
  );
}
