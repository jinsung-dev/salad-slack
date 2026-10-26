import { expect, test, type Browser, type Page } from "@playwright/test";

// Real browser sessions against the running dev stack (pnpm db:up && pnpm dev).

const run = Date.now().toString(36);

/** Signs in through the Google button; the server's fake provider asks for an account. */
async function signInAs(page: Page, name: string, path = "/") {
  await page.goto(path);
  await page.getByRole("link", { name: "Google 계정으로 로그인" }).click();
  await page.getByPlaceholder("이메일").fill(`${name}-${run}@example.test`);
  await page.getByPlaceholder("이름").fill(name);
  await page.getByRole("button", { name: "계속" }).click();
  await expect(page).not.toHaveURL(/\/login|127\.0\.0\.1:\d+\/authorize/);
}

async function newPerson(browser: Browser, name: string, path = "/"): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, name, path);
  return page;
}

/**
 * People in one new workspace: the first creates it with the test email domain,
 * the rest join it from onboarding, the way colleagues do.
 */
async function team(browser: Browser, workspace: string, ...names: string[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) {
    const page = await newPerson(browser, name);
    await expect(page).toHaveURL(/\/new$/);
    if (i === 0) {
      await page.getByPlaceholder(/^팀 이름/).fill(workspace);
      await page.getByPlaceholder(/^회사 이메일 도메인/).fill("example.test");
      await page.getByRole("button", { name: "만들기" }).click();
    } else {
      await page.locator(".joinable li").filter({ hasText: workspace }).getByRole("button", { name: "참여" }).click();
    }
    await expect(page.locator(".status-open")).toBeVisible();
    await expect(page.locator(".switcher-button")).toContainText(workspace);
    pages.push(page);
  }
  return pages;
}

async function createChannel(page: Page, name: string, isPrivate = false) {
  await page.getByRole("button", { name: "+ 채널 만들기" }).click();
  await page.getByPlaceholder(/^새-채널-이름/).fill(name);
  if (isPrivate) await page.getByLabel("비공개 채널").check();
  await page.getByRole("button", { name: "만들기" }).click();
  await expect(page.locator(".channel-header h1")).toContainText(name);
}

async function send(page: Page, placeholder: string, text: string) {
  const box = page.getByPlaceholder(placeholder);
  await box.fill(text);
  await box.press("Enter");
}

const message = (page: Page, text: string) => page.locator(".main .message").filter({ hasText: text });

test("two users chat in realtime with unread state", async ({ browser }) => {
  const channel = `e2e-${run}`;
  const [alice, bob] = await team(browser, `ws1-${run}`, `alice${run}`, `bob${run}`);

  await createChannel(alice, channel);
  // Bob sees the new channel arrive over the socket, previews it, and joins.
  await bob.getByRole("link", { name: `# ${channel}` }).click();
  await bob.getByRole("button", { name: "채널 참여" }).click();

  await send(alice, `#${channel}에 메시지 보내기`, "안녕 *bob* `code`");
  const bobMessage = bob.locator(".message .text").filter({ hasText: "안녕 bob code" });
  await expect(bobMessage).toBeVisible();
  await expect(bobMessage.locator("strong")).toHaveText("bob");

  // Away from the channel, a plain message bolds it and a mention adds a badge.
  await createChannel(bob, `${channel}-b`);
  await send(alice, `#${channel}에 메시지 보내기`, "두 번째");
  const link = bob.getByRole("link", { name: new RegExp(`^# ${channel}`) }).first();
  await expect(link).toHaveClass(/unread/);
  await expect(link.locator(".badge")).toHaveCount(0);

  const composer = alice.getByPlaceholder(`#${channel}에 메시지 보내기`);
  await composer.fill(`@bob${run}`);
  await alice.getByRole("option", { name: new RegExp(`@bob${run}`) }).click();
  await composer.press("End");
  await composer.pressSequentially("확인 부탁해요");
  await composer.press("Enter");
  await expect(link.locator(".badge")).toHaveText("1");

  await link.click();
  await expect(bob.locator(".mention.me")).toHaveText(`@bob${run}`);
  await expect(link.locator(".badge")).toHaveCount(0);
});

test("threads, reactions, edits and typing", async ({ browser }) => {
  const channel = `thr-${run}`;
  const [alice, bob] = await team(browser, `ws2-${run}`, `alicet${run}`, `bobt${run}`);
  await createChannel(alice, channel);
  await bob.getByRole("link", { name: `# ${channel}` }).click();
  await bob.getByRole("button", { name: "채널 참여" }).click();

  await send(alice, `#${channel}에 메시지 보내기`, "배포해도 될까요?");
  const question = message(bob, "배포해도 될까요?");
  await expect(question).toBeVisible();

  // Typing shows on the other side.
  await bob.getByPlaceholder(`#${channel}에 메시지 보내기`).fill("음");
  await expect(alice.getByText(`bobt${run} 님이 입력 중…`)).toBeVisible();
  await bob.getByPlaceholder(`#${channel}에 메시지 보내기`).fill("");

  // Bob reacts; Alice sees the count live.
  await question.hover();
  await question.getByRole("button", { name: "반응 추가" }).click();
  await question.getByRole("menuitem", { name: "👍 반응" }).click();
  await expect(message(alice, "배포해도 될까요?").getByRole("button", { name: "👍 1" })).toBeVisible();

  // Bob replies in a thread; Alice's message gains a reply summary.
  await question.hover();
  await question.getByRole("button", { name: "스레드에 답글" }).click();
  await send(bob, "답글 보내기", "네, 테스트 통과했어요");
  await expect(bob.locator(".thread .message").filter({ hasText: "테스트 통과" })).toBeVisible();
  const summary = message(alice, "배포해도 될까요?").locator(".thread-summary");
  await expect(summary).toContainText("답글 1개");
  await expect(message(alice, "테스트 통과")).toHaveCount(0); // replies stay out of the channel

  await summary.click();
  await expect(alice.locator(".thread .message").filter({ hasText: "테스트 통과" })).toBeVisible();

  // Alice edits her question; Bob sees the edit.
  const own = message(alice, "배포해도 될까요?");
  await own.hover();
  await own.getByRole("button", { name: "수정" }).click();
  const editor = own.locator(".edit-box textarea");
  await editor.fill("오늘 배포해도 될까요?");
  await editor.press("Enter");
  await expect(message(bob, "오늘 배포해도 될까요?")).toContainText("(수정됨)");

  await bob.screenshot({ path: "e2e/artifacts/phase2-thread.png" });
});

test("private channels and direct messages", async ({ browser }) => {
  const secret = `sec-${run}`;
  const [alice, bob] = await team(browser, `ws3-${run}`, `alicep${run}`, `bobp${run}`);

  await createChannel(alice, secret, true);
  await expect(alice.locator(".channel-header h1")).toContainText("🔒");
  await bob.reload();
  await expect(bob.locator(".status-open")).toBeVisible();
  await expect(bob.getByRole("link", { name: new RegExp(secret) })).toHaveCount(0);

  await alice.getByRole("button", { name: "사람 추가" }).click();
  await alice.getByPlaceholder("이름으로 찾기").fill(`bobp${run}`);
  await alice.getByLabel(`bobp${run}`).check();
  await alice.getByRole("button", { name: "추가", exact: true }).click();
  await expect(bob.getByRole("link", { name: new RegExp(secret) })).toBeVisible();

  // Alice opens a DM; it appears for Bob with Alice's name.
  await alice.getByRole("button", { name: "+ 새 메시지" }).click();
  await alice.getByPlaceholder("이름으로 찾기").fill(`bobp${run}`);
  await alice.getByLabel(`bobp${run}`).check();
  await alice.getByRole("button", { name: "대화 시작" }).click();
  await send(alice, `bobp${run}에게 메시지 보내기`, "개인적으로 물어볼 게 있어요");
  const dm = bob.getByRole("link", { name: new RegExp(`alicep${run}`) });
  await expect(dm.locator(".badge")).toHaveText("1");
  await dm.click();
  await expect(message(bob, "개인적으로 물어볼 게 있어요")).toBeVisible();
  await expect(bob.locator(".channel-header .presence-active")).toBeVisible();
});

test("signing out returns to sign-in, also for other tabs of the session", async ({ browser }) => {
  const name = `out${run}`;
  const [page] = await team(browser, `ws-out-${run}`, name);
  const otherTab = await page.context().newPage();
  await otherTab.goto("/");
  await expect(otherTab.locator(".status-open")).toBeVisible();
  await createChannel(page, `out-${run}`);
  await otherTab.getByRole("link", { name: `# out-${run}` }).click();

  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByRole("link", { name: "Google 계정으로 로그인" })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);

  // The other tab learns on its next request that the session is gone.
  await send(otherTab, `#out-${run}에 메시지 보내기`, "still here?");
  await expect(otherTab.getByRole("link", { name: "Google 계정으로 로그인" })).toBeVisible();

  // Signing back in with the same account shows the same workspace.
  await signInAs(page, name);
  await expect(page.locator(".status-open")).toBeVisible();
  await expect(page.getByRole("link", { name: `# out-${run}` })).toBeVisible();
});

test("files, search and notification settings", async ({ browser }) => {
  const channel = `p3-${run}`;
  const [alice, bob] = await team(browser, `ws4-${run}`, `alicef${run}`, `bobf${run}`);
  await createChannel(alice, channel);
  await bob.getByRole("link", { name: `# ${channel}` }).click();
  await bob.getByRole("button", { name: "채널 참여" }).click();

  // Alice attaches an image and a document; Bob sees the image inline and the document as a card.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await alice.locator('input[type="file"]').setInputFiles([
    { name: "화면.png", mimeType: "image/png", buffer: png },
    { name: "회의록.txt", mimeType: "text/plain", buffer: Buffer.from("배포 체크리스트") },
  ]);
  await expect(alice.locator(".attachment.done")).toHaveCount(2);
  await send(alice, `#${channel}에 메시지 보내기`, `배포 자료 ${run}`);
  const shared = message(bob, `배포 자료 ${run}`);
  await expect(shared.locator(".file-image img")).toHaveAttribute("alt", "화면.png");
  await expect(shared.locator(".file-card")).toContainText("회의록.txt");
  // The image loads lazily; wait until the browser has decoded it.
  await expect.poll(() => shared.locator(".file-image img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  // Bob searches with a partial word and opens the result beside the channel.
  await bob.getByRole("searchbox", { name: "메시지 검색" }).fill(`배포 ${run}`);
  await bob.getByRole("searchbox", { name: "메시지 검색" }).press("Enter");
  const result = bob.locator(".search-result").filter({ hasText: `자료 ${run}` });
  await expect(result.locator("mark").first()).toHaveText("배포");
  await result.click();
  await expect(bob.locator(".thread .message").filter({ hasText: `배포 자료 ${run}` })).toBeVisible();

  // Bob saves the message and finds it under saved messages.
  await shared.hover();
  await shared.getByRole("button", { name: "저장", exact: true }).click();
  await expect(shared.getByRole("button", { name: "저장 취소" })).toBeVisible();
  await bob.getByRole("link", { name: "저장한 메시지" }).click();
  await expect(bob.locator(".search-result").filter({ hasText: `배포 자료 ${run}` })).toBeVisible();
  await bob.getByRole("link", { name: `# ${channel}` }).click();

  // Muting dims the channel in the sidebar.
  await bob.getByLabel("알림 수준").selectOption("none");
  await expect(bob.getByRole("link", { name: `# ${channel}` })).toHaveClass(/muted-channel/);
  await bob.getByRole("button", { name: "설정" }).click();
  await expect(bob.getByRole("dialog", { name: "설정" })).toContainText("데스크톱 알림");
  await bob.screenshot({ path: "e2e/artifacts/phase3.png" });
});

test("workspaces: guest invite, webhook, and switching", async ({ browser, request }) => {
  const [owner] = await team(browser, `ws5-${run}`, `owner${run}`);
  await createChannel(owner, `general-${run}`);
  await createChannel(owner, `project-${run}`);

  // The owner makes a guest invite link in the admin page.
  await owner.locator(".switcher-button").click();
  await owner.getByRole("menuitem", { name: "워크스페이스 관리" }).click();
  await owner.getByLabel("초대 역할").selectOption("guest");
  await owner.getByRole("button", { name: "초대 링크 만들기" }).click();
  const inviteUrl = await owner.getByLabel("초대 링크").inputValue();
  expect(inviteUrl).toContain("/invite/");

  // The guest opens it signed out, signs in, comes back to it, and joins.
  const guest = await newPerson(browser, `guest${run}`, new URL(inviteUrl).pathname);
  await expect(guest.getByRole("heading", { name: `ws5-${run}` })).toBeVisible();
  await guest.getByRole("button", { name: "참여하기" }).click();
  await expect(guest.locator(".switcher-button")).toContainText(`ws5-${run}`);
  await expect(guest.getByText("아직 참여한 대화가 없습니다")).toBeVisible();
  await expect(guest.getByRole("button", { name: "+ 채널 만들기" })).toHaveCount(0);
  await expect(guest.getByRole("link", { name: `# general-${run}` })).toHaveCount(0);

  // A webhook posts into the project channel.
  await owner.getByLabel("웹훅 채널").selectOption({ label: `#project-${run}` });
  await owner.getByLabel("웹훅 이름").fill("배포 알림");
  await owner.getByRole("button", { name: "웹훅 만들기" }).click();
  const hookUrl = await owner.getByLabel("웹훅 URL").inputValue();
  await owner.getByRole("link", { name: /돌아가기/ }).click();
  await owner.getByRole("link", { name: `# project-${run}` }).click();
  const res = await request.post(new URL(hookUrl).pathname, { data: { text: `v1.2 배포 완료 ${run}` } });
  expect(res.status()).toBe(201);
  const posted = message(owner, `v1.2 배포 완료 ${run}`);
  await expect(posted).toContainText("배포 알림");

  // Adding the guest to the project channel makes it appear for them, live.
  await owner.getByRole("button", { name: "사람 추가" }).click();
  await owner.getByPlaceholder("이름으로 찾기").fill(`guest${run}`);
  await owner.getByLabel(`guest${run}`).check();
  await owner.getByRole("button", { name: "추가", exact: true }).click();
  await guest.getByRole("link", { name: `# project-${run}` }).click();
  await expect(message(guest, `v1.2 배포 완료 ${run}`)).toBeVisible();

  // A second workspace is a separate space; switching back restores the first.
  await owner.locator(".switcher-button").click();
  await owner.getByRole("menuitem", { name: "+ 워크스페이스 추가" }).click();
  await owner.getByPlaceholder(/^팀 이름/).fill(`other-${run}`);
  await owner.getByRole("button", { name: "만들기" }).click();
  await expect(owner.locator(".switcher-button")).toContainText(`other-${run}`);
  await expect(owner.getByRole("link", { name: `# project-${run}` })).toHaveCount(0);
  await owner.locator(".switcher-button").click();
  await owner.getByRole("menuitem", { name: `ws5-${run}` }).click();
  await expect(owner.getByRole("link", { name: `# project-${run}` })).toBeVisible();
  await owner.screenshot({ path: "e2e/artifacts/phase4.png" });
});

test("an outside guest invited to one channel lands in it and sees nothing else", async ({ browser }) => {
  const [owner] = await team(browser, `ws6-${run}`, `lead${run}`);
  await createChannel(owner, `internal-${run}`);
  await send(owner, `#internal-${run}에 메시지 보내기`, "내부 공지");
  await createChannel(owner, `partner-${run}`, true);
  await send(owner, `#partner-${run}에 메시지 보내기`, `킥오프 자료 ${run}`);

  await owner.getByRole("button", { name: "외부인 초대" }).click();
  await owner.getByLabel("게스트 기간").selectOption({ label: "30일" });
  await owner.getByRole("button", { name: "초대 링크 만들기" }).click();
  const link = await owner.getByLabel("채널 초대 링크").inputValue();
  await owner.getByRole("button", { name: "닫기" }).click();

  const partner = await newPerson(browser, `partner${run}`, new URL(link).pathname);
  await expect(partner.getByText(`#partner-${run}`)).toBeVisible();
  await expect(partner.getByText("30일 뒤 자동으로 나가게 됩니다")).toBeVisible();
  await partner.getByRole("button", { name: "참여하기" }).click();
  await expect(partner.locator(".channel-header h1")).toContainText(`partner-${run}`);
  await expect(message(partner, `킥오프 자료 ${run}`)).toBeVisible();
  await expect(partner.getByRole("link", { name: `# internal-${run}` })).toHaveCount(0);
  await expect(partner.getByRole("button", { name: "외부인 초대" })).toHaveCount(0);

  await send(partner, `#partner-${run}에 메시지 보내기`, "확인했습니다");
  const fromGuest = message(owner, "확인했습니다");
  await expect(fromGuest.locator(".guest-badge")).toHaveText("게스트");
  await owner.screenshot({ path: "e2e/artifacts/channel-guest.png" });
});

test("moving between screens keeps one realtime connection", async ({ browser }) => {
  const [page] = await team(browser, `ws7-${run}`, `nav${run}`);
  await createChannel(page, `nav-${run}`);
  let sockets = 0;
  page.on("websocket", () => sockets++);
  await page.getByRole("link", { name: "저장한 메시지" }).click();
  await page.getByRole("link", { name: `# nav-${run}` }).click();
  await page.locator(".switcher-button").click();
  await page.getByRole("menuitem", { name: "워크스페이스 관리" }).click();
  await page.getByRole("link", { name: /돌아가기/ }).click();
  await expect(page.locator(".status-open")).toBeVisible();
  expect(sockets).toBe(0);
});

test("apps: bot in a channel, slash command with buttons, ephemeral replies", async ({ browser, request }) => {
  // The app's server, as a team would run it.
  const { createServer } = await import("node:http");
  const appServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const reply =
        req.url === "/commands"
          ? {
              text: `배포 요청: ${body.text}`,
              responseType: "in_channel",
              blocks: [
                { type: "section", text: `*${body.text}* 배포를 승인할까요?`, fields: [`요청자: ${body.user.displayName}`] },
                { type: "actions", elements: [{ type: "button", text: "승인", actionId: "approve", style: "primary" }] },
              ],
            }
          : { text: `${body.user.displayName} 님이 승인했습니다 ✅`, replaceOriginal: true };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  const appUrl = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;

  const [admin] = await team(browser, `ws8-${run}`, `admin${run}`);
  await createChannel(admin, `deploys-${run}`);

  await admin.locator(".switcher-button").click();
  await admin.getByRole("menuitem", { name: "워크스페이스 관리" }).click();
  await admin.getByLabel("앱 이름").fill("배포봇");
  await admin.getByRole("button", { name: "앱 만들기" }).click();
  const token = await admin.getByLabel("봇 토큰").inputValue();
  expect(token).toMatch(/^xcb-/);
  await admin.locator(".app-card summary").filter({ hasText: "배포봇" }).click();
  await admin.getByLabel(/chat:write —/).check();
  await admin.getByLabel("버튼 클릭 URL").fill(`${appUrl}/actions`);
  await admin.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(admin.getByText("저장했습니다.").first()).toBeVisible();
  await admin.getByLabel("명령 이름").fill("deploy");
  await admin.getByLabel("명령 URL").fill(`${appUrl}/commands`);
  await admin.getByLabel("명령 설명").fill("배포 요청");
  await admin.getByRole("button", { name: "명령 추가" }).click();
  await expect(admin.locator(".app-card").getByText("/deploy")).toBeVisible();
  expect((await request.get("/api/bot/v1/auth.test", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);

  // Add the bot to the channel like a person.
  await admin.getByRole("link", { name: /돌아가기/ }).click();
  await admin.getByRole("link", { name: `# deploys-${run}` }).click();
  await admin.getByRole("button", { name: "사람 추가" }).click();
  await admin.getByPlaceholder("이름으로 찾기").fill("배포봇");
  await admin.getByLabel("배포봇").check();
  await admin.getByRole("button", { name: "추가", exact: true }).click();

  // Run the command: the reply arrives with a button; clicking it lets the app replace the message.
  const box = admin.getByPlaceholder(`#deploys-${run}에 메시지 보내기`);
  await box.fill("/dep");
  await expect(admin.locator(".command-hints")).toContainText("/deploy");
  await box.fill("/deploy prod");
  await box.press("Enter");
  const reply = message(admin, "배포를 승인할까요?");
  await expect(reply.locator(".bot-badge")).toHaveText("앱");
  await expect(reply.locator(".block-fields")).toContainText(`요청자: admin${run}`);
  await reply.getByRole("button", { name: "승인" }).click();
  await expect(message(admin, `admin${run} 님이 승인했습니다`)).toBeVisible();
  await expect(message(admin, "배포를 승인할까요?")).toHaveCount(0);

  await box.fill("/nope");
  await box.press("Enter");
  await expect(admin.locator(".message.ephemeral")).toContainText("등록된 명령이 아닙니다");
  await expect(admin.locator(".message.ephemeral")).toContainText("나에게만 보임");
  await admin.screenshot({ path: "e2e/artifacts/apps.png" });
  await new Promise<void>((r) => appServer.close(() => r()));
});
