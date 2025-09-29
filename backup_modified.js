function generateOffsets(startOffset, total) {
  const interval = 20;
  const start = startOffset + interval;
  const offsets = [];
  for (let i = start; i <= total; i += interval) {
    offsets.push(i);
  }
  return offsets;
}

function sleep(ms = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseConversation(rawConversation) {
  const title = rawConversation.title;
  const create_time = rawConversation.create_time;
  const mapping = rawConversation.mapping;
  const keys = Object.keys(mapping);
  const messages = [];

  for (const k of keys) {
    const msgPayload = mapping[k];
    const msg = msgPayload.message;
    if (!msg) continue;

    const role = msg.author?.role || "unknown";
    const model = msg.metadata?.model_slug || "unknown";
    const create_time = msg.create_time;

    let content = "";
    if (msg.content?.parts) {
      content = msg.content.parts.join("\n");
    } else if (msg.content?.text) {
      content = msg.content.text;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(c => c.text || JSON.stringify(c)).join("\n");
    } else {
      content = JSON.stringify(msg.content);
    }

    messages.push({ role, content, model, create_time });
  }

  return { messages, create_time, title };
}

function getRequestCount(total, startOffset, stopOffset) {
  if (stopOffset === -1) return total;
  return stopOffset - startOffset;
}

function logProgress(total, messages, offset) {
  let progress = Math.round((messages / total) * 100);
  if (progress > 100) progress = 100;
  console.log(`GPT-BACKUP::PROGRESS::${progress}%::OFFSET::${offset}`);
}

function getDateFormat(date) {
  const year = date.getFullYear();
  const month = ("0" + (date.getMonth() + 1)).slice(-2);
  const day = ("0" + date.getDate()).slice(-2);
  const hours = ("0" + date.getHours()).slice(-2);
  const minutes = ("0" + date.getMinutes()).slice(-2);
  const seconds = ("0" + date.getSeconds()).slice(-2);
  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

function downloadJson(data) {
  const jsonString = JSON.stringify(data, null, 2);
  const jsonBlob = new Blob([jsonString], { type: "application/json" });
  const downloadLink = document.createElement("a");
  downloadLink.href = URL.createObjectURL(jsonBlob);
  downloadLink.download = `gpt-backup-${getDateFormat(new Date())}.json`;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  return new Promise((resolve) => {
    setTimeout(() => {
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(downloadLink.href);
      resolve();
    }, 150);
  });
}

async function loadToken() {
  const res = await fetch("https://chatgpt.com/api/auth/session");
  if (!res.ok) throw new Error("failed to fetch token");
  const json = await res.json();
  return json.accessToken;
}

async function getConversationIds(token, offset = 0) {
  const res = await fetch(
    `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=20`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("failed to fetch conversation ids");
  const json = await res.json();
  return { items: json.items.map((item) => ({ ...item, offset })), total: json.total };
}

async function fetchConversation(token, id, maxAttempts = 3, attempt = 1) {
  const INITIAL_BACKOFF = 10000;
  const BACKOFF_MULTIPLIER = 2;
  try {
    const res = await fetch(
      `https://chatgpt.com/backend-api/conversation/${id}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error("Unsuccessful response");
    return res.json();
  } catch (error) {
    if (attempt >= maxAttempts) {
      throw new Error(`Failed after ${maxAttempts} attempts.`);
    } else {
      const backoff = INITIAL_BACKOFF * Math.pow(BACKOFF_MULTIPLIER, attempt);
      console.log(`Error. Retrying in ${backoff}ms.`);
      await sleep(backoff);
      return fetchConversation(token, id, maxAttempts, attempt + 1);
    }
  }
}

async function getAllConversations(startOffset, stopOffset) {
  const token = await loadToken();

  const { total, items: firstBatch } = await getConversationIds(token, startOffset);
  const offsets = generateOffsets(startOffset, total);

  let allItems = [...firstBatch];

  for (const offset of offsets) {
    if (offset === stopOffset) break;
    await sleep();
    const { items } = await getConversationIds(token, offset);
    allItems.push(...items);
  }

  // Deduplicate by id
  const uniqueItems = Array.from(new Map(allItems.map(i => [i.id, i])).values());

  const lastOffset = stopOffset === -1 ? offsets[offsets.length - 1] : stopOffset;
  const requested = getRequestCount(total, startOffset, stopOffset);

  console.log(`GPT-BACKUP::STARTING::TOTAL-OFFSETS::${lastOffset}`);
  console.log(`GPT-BACKUP::STARTING::REQUESTED-MESSAGES::${requested}`);
  console.log(`GPT-BACKUP::STARTING::TOTAL-MESSAGES::${total}`);

  const allConversations = [];
  for (const item of uniqueItems) {
    await sleep(1000); // throttle: 60 req/min
    if (allConversations.length % 20 === 0) {
      logProgress(requested, allConversations.length, item.offset);
    }
    const rawConversation = await fetchConversation(token, item.id);
    const conversation = parseConversation(rawConversation);
    allConversations.push(conversation);
  }

  logProgress(requested, allConversations.length, lastOffset);
  return allConversations;
}

(async () => {
  const START_OFFSET = 0;
  const STOP_OFFSET = -1; // -1 = all conversations
  const allConversations = await getAllConversations(START_OFFSET, STOP_OFFSET);
  await downloadJson(allConversations);
  console.log("GPT-BACKUP::DONE");
})();
