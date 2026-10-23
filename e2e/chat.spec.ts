import { expect, test, type Browser, type Page } from "@playwright/test";

// Real browser sessions against the running dev stack (pnpm db:up && pnpm dev).

const run = Date.now().toString(36);

/** Signs in through the Google button; the dev server's fake provider asks for an account. */
async function signInAs(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Google 계정으로 로그인" }).click();
  await page.getByPlaceholder("이메일").fill(`${name}-${run}@example.test`);
  await page.getByPlaceholder("이름").fill(name);
  await page.getByRole("button", { name: "계속" }).click();
  await expect(page.locator(".status-open")).toBeVisible();
}

async function signUp(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, name);
  return page;
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
  const alice = await signUp(browser, `alice${run}`);
  const bob = await signUp(browser, `bob${run}`);

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
  const alice = await signUp(browser, `alicet${run}`);
  const bob = await signUp(browser, `bobt${run}`);
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
  const alice = await signUp(browser, `alicep${run}`);
  const bob = await signUp(browser, `bobp${run}`);

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
  const page = await signUp(browser, name);
  const otherTab = await page.context().newPage();
  await otherTab.goto("/");
  await expect(otherTab.locator(".status-open")).toBeVisible();
  await createChannel(page, `out-${run}`);
  await otherTab.getByRole("link", { name: `# out-${run}` }).click();

  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("link", { name: "Google 계정으로 로그인" })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);

  // The other tab learns on its next request that the session is gone.
  await send(otherTab, `#out-${run}에 메시지 보내기`, "still here?");
  await expect(otherTab.getByRole("link", { name: "Google 계정으로 로그인" })).toBeVisible();

  // Signing back in with the same account shows the same workspace.
  await signInAs(page, name);
  await expect(page.getByRole("link", { name: `# out-${run}` })).toBeVisible();
});

test("files, search and notification settings", async ({ browser }) => {
  const channel = `p3-${run}`;
  const alice = await signUp(browser, `alicef${run}`);
  const bob = await signUp(browser, `bobf${run}`);
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
  expect(await shared.locator(".file-image img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

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
