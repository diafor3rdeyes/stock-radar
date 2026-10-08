// 슬랙 알림. 두 방식 중 하나를 쓴다(봇 토큰이 있으면 봇 방식이 우선).
//  1) 봇 토큰: SLACK_BOT_TOKEN(xoxb-…) + SLACK_CHANNEL(채널 ID, 기본 #매수에임알람) → 앱(봇) 이름으로 chat.postMessage 전송.
//     SLACK_MENTION_USER(내 슬랙 멤버 ID, 선택)를 넣으면 메시지 앞에 @멘션이 붙어 모바일 푸시가 확실하게 옵니다.
//  2) 인커밍 웹훅: SLACK_WEBHOOK_URL
const DEFAULT_CHANNEL = 'C0C7MM6PTFC'; // #매수에임알람

export const slackConfigured = (env) => !!((env.SLACK_BOT_TOKEN || '').trim() || (env.SLACK_WEBHOOK_URL || '').trim());

export async function sendSlack(env, text) {
  const token = (env.SLACK_BOT_TOKEN || '').trim();
  const mention = (env.SLACK_MENTION_USER || '').trim();
  const body = mention ? `<@${mention}> ${text}` : text;
  try {
    if (token) {
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          channel: (env.SLACK_CHANNEL || '').trim() || DEFAULT_CHANNEL,
          text: body,
          unfurl_links: false,
          link_names: true,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const hint =
          j.error === 'not_in_channel' || j.error === 'channel_not_found'
            ? ' — 슬랙 채널에서 /invite @봇이름 으로 봇을 초대해 주세요.'
            : j.error === 'invalid_auth' || j.error === 'not_authed' || j.error === 'token_revoked'
            ? ' — 봇 토큰(SLACK_BOT_TOKEN)을 확인해 주세요.'
            : j.error === 'missing_scope'
            ? ' — 봇에 chat:write 권한을 추가하고 앱을 다시 설치해 주세요.'
            : '';
        return { ok: false, error: `슬랙 오류: ${j.error || r.status}${hint}` };
      }
      return { ok: true };
    }
    const url = (env.SLACK_WEBHOOK_URL || '').trim();
    if (!url) return { ok: false, error: 'SLACK_BOT_TOKEN(또는 SLACK_WEBHOOK_URL)이 설정되지 않았습니다.' };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: body }),
    });
    if (!r.ok) return { ok: false, error: `슬랙 응답 ${r.status}: ${(await r.text()).slice(0, 120)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
