import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import axios from "axios";

axios.defaults.timeout = 300000;

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const SMART_CODER_API_URL: string = core.getInput("SMART_CODER_API_URL");
const SMART_CODER_API_KEY: string = core.getInput("SMART_CODER_API_KEY");

console.log("GITHUB_TOKEN", GITHUB_TOKEN);
console.log("SMART_CODER_API_URL", SMART_CODER_API_URL);
console.log("SMART_CODER_API_KEY", SMART_CODER_API_KEY);

const octokit = new Octokit({ auth: GITHUB_TOKEN });

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  pr: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const diff = formatDiff(chunk);
      const response = await request(file, pr, diff);
      console.log("response:", response);
      // const aiResponse = await getAIResponse(prompt);
      if (response) {
        const newComments = createComment(file, response);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function formatDiff(chunk: Chunk): string {
  return `\`\`\`diff
  ${chunk.content}
  ${chunk.changes
    // @ts-expect-error - ln and ln2 exists where needed
    .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
    .join("\n")}
  \`\`\`
  `;
}

function extractFuncionId() {
  const pettern = /FUNCTION\/(\d+)\/runs/;
  const matchs = SMART_CODER_API_URL.match(pettern);
  if (!matchs) {
    return 0;
  }
  return matchs[1];
}

async function request(file: File, pr: PRDetails, params: string) {
  const functionId = extractFuncionId();
  if (!functionId) {
    console.error("Unsupported api");
    return;
  }

  const read = async () => {
    return new Promise<Array<{ lineNumber: string; reviewComment: string }>>(
      (resolve, reject) => {
        axios({
          method: "post",
          url: SMART_CODER_API_URL,
          data: {
            functionId: functionId,
            stepNumber: 1,
            variables: [
              {
                key: "diff",
                type: "TEXT",
                value: params,
              },
              {
                key: "file",
                type: "TEXT",
                value: file.to,
              },
              {
                key: "title",
                type: "TEXT",
                value: pr.title,
              },
              {
                key: "description",
                type: "TEXT",
                value: pr.description,
              },
            ],
          },
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${SMART_CODER_API_KEY}`,
          },
          responseType: "stream",
        })
          .then((response) => {
            const chunks: String[] = [];
            const reader = response.data;
            const decoder = new TextDecoder("utf-8");
            const pattern = /data:.*?"done":(true|false)}\n\n/;
            let buffer = "";
            let bufferObj: any;

            reader.on("readable", () => {
              let chunk;
              while ((chunk = reader.read()) !== null) {
                buffer += decoder.decode(chunk, { stream: true });
                do {
                  // 循环匹配数据包(处理粘包)，不能匹配就退出解析循环去读取数据(处理数据包不完整)
                  const match = buffer.match(pattern);
                  if (!match) {
                    break;
                  }
                  buffer = buffer.substring(match[0].length);

                  bufferObj = JSON.parse(match[0].replace("data:", ""));
                  const data = bufferObj.data;

                  if (!data) throw new Error("Empty Message Events");
                  chunks.push(data.message);
                } while (true);
              }
            });

            reader.on("end", () => {
              console.log("reader end:\n", chunks.join(""));
              resolve(JSON.parse(chunks.join("")));
              console.log("----> end");
            });
          })
          .catch((reason: any) => {
            console.log("reason:", reason);
          });
      }
    );
  };

  return await read();
}

function createComment(
  file: File,
  responses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return responses.flatMap((v) => {
    if (!file.to) {
      return [];
    }
    return {
      body: v.reviewComment,
      path: file.to,
      line: Number(v.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  console.log("process.env.GITHUB_EVENT_PATH", process.env.GITHUB_EVENT_PATH);
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  console.log("eventData: ", eventData);

  if (eventData.action === "opened" || eventData.action === "reopened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
