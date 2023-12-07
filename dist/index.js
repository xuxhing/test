"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const core = __importStar(require("@actions/core"));
const rest_1 = require("@octokit/rest");
const parse_diff_1 = __importDefault(require("parse-diff"));
const minimatch_1 = __importDefault(require("minimatch"));
const axios_1 = __importDefault(require("axios"));
axios_1.default.defaults.timeout = 300000;
const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const SMART_CODER_API_URL = core.getInput("SMART_CODER_API_URL");
const SMART_CODER_API_KEY = core.getInput("SMART_CODER_API_KEY");
console.log("GITHUB_TOKEN", GITHUB_TOKEN);
console.log("SMART_CODER_API_URL", SMART_CODER_API_URL);
console.log("SMART_CODER_API_KEY", SMART_CODER_API_KEY);
const octokit = new rest_1.Octokit({ auth: GITHUB_TOKEN });
function getPRDetails() {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const { repository, number } = JSON.parse((0, fs_1.readFileSync)(process.env.GITHUB_EVENT_PATH || "", "utf8"));
        const prResponse = yield octokit.pulls.get({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: number,
        });
        return {
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: number,
            title: (_a = prResponse.data.title) !== null && _a !== void 0 ? _a : "",
            description: (_b = prResponse.data.body) !== null && _b !== void 0 ? _b : "",
        };
    });
}
function getDiff(owner, repo, pull_number) {
    return __awaiter(this, void 0, void 0, function* () {
        const response = yield octokit.pulls.get({
            owner,
            repo,
            pull_number,
            mediaType: { format: "diff" },
        });
        // @ts-expect-error - response.data is a string
        return response.data;
    });
}
function analyzeCode(parsedDiff, pr) {
    return __awaiter(this, void 0, void 0, function* () {
        const comments = [];
        for (const file of parsedDiff) {
            if (file.to === "/dev/null")
                continue; // Ignore deleted files
            for (const chunk of file.chunks) {
                const diff = formatDiff(chunk);
                const response = yield request(file, pr, diff);
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
    });
}
function formatDiff(chunk) {
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
function request(file, pr, params) {
    return __awaiter(this, void 0, void 0, function* () {
        const functionId = extractFuncionId();
        if (!functionId) {
            console.error("Unsupported api");
            return;
        }
        const read = () => __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                (0, axios_1.default)({
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
                    const chunks = [];
                    const reader = response.data;
                    const decoder = new TextDecoder("utf-8");
                    const pattern = /data:.*?"done":(true|false)}\n\n/;
                    let buffer = "";
                    let bufferObj;
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
                                if (!data)
                                    throw new Error("Empty Message Events");
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
                    .catch((reason) => {
                    console.log("reason:", reason);
                });
            });
        });
        return yield read();
    });
}
function createComment(file, responses) {
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
function createReviewComment(owner, repo, pull_number, comments) {
    return __awaiter(this, void 0, void 0, function* () {
        yield octokit.pulls.createReview({
            owner,
            repo,
            pull_number,
            comments,
            event: "COMMENT",
        });
    });
}
function main() {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const prDetails = yield getPRDetails();
        let diff;
        const eventData = JSON.parse((0, fs_1.readFileSync)((_a = process.env.GITHUB_EVENT_PATH) !== null && _a !== void 0 ? _a : "", "utf8"));
        console.log("eventData.action: ", eventData.action);
        if (eventData.action === "opened" || eventData.action === "reopened") {
            diff = yield getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
        }
        else if (eventData.action === "synchronize") {
            const newBaseSha = eventData.before;
            const newHeadSha = eventData.after;
            const response = yield octokit.repos.compareCommits({
                headers: {
                    accept: "application/vnd.github.v3.diff",
                },
                owner: prDetails.owner,
                repo: prDetails.repo,
                base: newBaseSha,
                head: newHeadSha,
            });
            diff = String(response.data);
        }
        else {
            console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
            return;
        }
        if (!diff) {
            console.log("No diff found");
            return;
        }
        const parsedDiff = (0, parse_diff_1.default)(diff);
        const excludePatterns = core
            .getInput("exclude")
            .split(",")
            .map((s) => s.trim());
        const filteredDiff = parsedDiff.filter((file) => {
            return !excludePatterns.some((pattern) => { var _a; return (0, minimatch_1.default)((_a = file.to) !== null && _a !== void 0 ? _a : "", pattern); });
        });
        const comments = yield analyzeCode(filteredDiff, prDetails);
        if (comments.length > 0) {
            yield createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
        }
    });
}
main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
