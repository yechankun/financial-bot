import fs from "node:fs/promises";
import path from "node:path";

import { MessageFlags } from "discord.js";

import { acquireChannelRunLock } from "../channelRunLock.js";
import { findActiveSkill, loadActiveSkills } from "../skillWhitelist.js";
import {
  fetchReportAccessStatus,
  fetchReportCache,
  grantReportAccess,
  putReportCache,
} from "../gateways/internal/appGateway.js";
import {
  loadReportBenchmarkContext,
  enqueueBenchmarkFollowup,
} from "../gateways/internal/benchmarkGateway.js";
import {
  createReportRun,
  runGuardStage,
  runProducerStage,
  runReportStage,
  runResearchStage,
} from "../gateways/internal/reportGateway.js";
import { produceCandidateCharts } from "../gateways/internal/chartGateway.js";
import {
  createProgressMessage,
  editProgressMessage,
  resolvePostingChannel,
} from "../channels/discord/responders/channelMessages.js";
import {
  buildMetricsLine,
  buildProgressMessage,
  formatElapsedDuration,
  loadAttachments,
  toNyangSentence,
} from "../channels/discord/responders/reportProgress.js";
import {
  buildResearchArtifactPaths,
  ensureArtifactParentDirs,
  materializeReportArtifacts,
  resolveResearchMarkdown,
  serializeReportArtifacts,
  validateArtifactPathsExist,
  validateReportArtifacts,
} from "../shared/reportArtifacts.js";
import {
  buildReportCacheDescriptor,
} from "../shared/reportCache.js";
import { hasCapability } from "../runtimeCapabilities.js";
import { enqueueReportJob, waitForReportJobResult } from "../reportJobQueue.js";

const REPORT_CACHE_TTL_MS = 60 * 60 * 1000;

async function waitForMaterializedReportArtifacts(runDir, report, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await validateReportArtifacts(runDir, report);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw lastError || new Error("리포트 산출물이 제때 동기화되지 않았다냥.");
}

async function handleDispatchedReport({
  interaction,
  skill,
  question,
  startedAt,
  cacheDescriptor,
}) {
  const { runId, runDir } = createReportRun(skill.name);

  await interaction.editReply({
    content:
      "리포트 작업을 worker에 전달했다냥. 결과를 기다리고 있다냥.",
  });

  const queueItem = await enqueueReportJob({
    runId,
    skillName: skill.name,
    question,
  });
  const result = await waitForReportJobResult(queueItem.queueId, 14 * 60 * 1000);

  if (!result) {
    await interaction.editReply({
      content:
        "리포트 작업이 아직 끝나지 않았다냥. worker에서 계속 처리 중이지만 자동 후속 게시까지는 아직 연결되지 않았다냥.",
    });
    return;
  }

  if (result.status === "rejected") {
    await interaction.editReply({
      content: toNyangSentence(
        result.reason,
        "이 질문은 사전 검사에서 통과하지 못했다냥.",
      ),
    });
    return;
  }

  if (result.status !== "ok") {
    throw new Error(result.error || "worker 리포트 실행에 실패했다냥.");
  }

  const accessGrant = await grantReportAccess({
    discordUserId: interaction.user.id,
  });
  if (!accessGrant.allowed) {
    await interaction.editReply({
      content: accessGrant.reason || "현재 `/report`를 사용할 수 없다냥.",
    });
    return;
  }

  const materializedReport = materializeReportArtifacts(runDir, result.report);
  await waitForMaterializedReportArtifacts(runDir, materializedReport);

  await putReportCache({
    cacheKey: cacheDescriptor.cacheKey,
    discordUserId: interaction.user.id,
    skill: skill.name,
    questionNormalized: cacheDescriptor.questionNormalized,
    questionHash: cacheDescriptor.questionHash,
    marketSnapshotDate: cacheDescriptor.marketSnapshotDate,
    marketSessionState: cacheDescriptor.marketSessionState,
    reportMode: cacheDescriptor.reportMode,
    runDir,
    result: {
      report: result.report,
      metrics: result.metrics || {},
    },
    expiresAt: new Date(Date.now() + REPORT_CACHE_TTL_MS).toISOString(),
  });

  const attachments = await loadAttachments(materializedReport.png_paths);
  const finalMessageBase = [
    `리포트 완성이다냥! (${skill.name}, 소요시간: ${formatElapsedDuration(startedAt)})`,
    buildMetricsLine(result.metrics || {}),
  ].join("\n");
  const finalMessage = result.benchmark?.message
    ? [finalMessageBase, result.benchmark.message].join("\n")
    : finalMessageBase;

  await interaction.editReply({
    content:
      accessGrant.access_type === "free_once_consumed"
        ? [
            "무료 `/report` 1회를 사용했다냥.",
            finalMessage,
          ].join("\n")
        : finalMessage,
    files: attachments,
  });
}

async function tryServeCachedReport({
  interaction,
  skill,
  cacheDescriptor,
  startedAt,
}) {
  const cache = await fetchReportCache({
    skill: skill.name,
    questionNormalized: cacheDescriptor.questionNormalized,
    marketSnapshotDate: cacheDescriptor.marketSnapshotDate,
    marketSessionState: cacheDescriptor.marketSessionState,
    reportMode: cacheDescriptor.reportMode,
  });

  if (!cache?.result?.report || !cache.run_dir) {
    return false;
  }

  const materializedReport = materializeReportArtifacts(
    cache.run_dir,
    cache.result.report,
  );

  try {
    await validateReportArtifacts(cache.run_dir, materializedReport);
  } catch {
    return false;
  }

  const accessGrant = await grantReportAccess({
    discordUserId: interaction.user.id,
  });
  if (!accessGrant.allowed) {
    await interaction.editReply({
      content: accessGrant.reason || "현재 `/report`를 사용할 수 없다냥.",
    });
    return true;
  }

  const attachments = await loadAttachments(materializedReport.png_paths);
  const finalMessage = [
    accessGrant.access_type === "free_once_consumed"
      ? "무료 `/report` 1회를 사용했다냥."
      : "캐시된 리포트를 바로 꺼내왔다냥.",
    `리포트 완성이다냥! (${skill.name}, 소요시간: ${formatElapsedDuration(startedAt)})`,
    buildMetricsLine(cache.result.metrics || {}),
    "동일 조건의 최근 리포트를 재사용했다냥.",
  ].join("\n");

  await interaction.editReply({
    content: finalMessage,
    files: attachments,
  });
  return true;
}

export async function requestReport({
  interaction,
  channelKey,
  activeChannelRuns,
  consumeChartQueueBatch,
  consumeBenchmarkQueueBatch,
}) {
  const skillName = interaction.options.getString("skill", true);
  const question = interaction.options.getString("question", true).trim();
  const skill = await findActiveSkill(skillName);

  if (!skill) {
    const activeSkills = await loadActiveSkills();
    throw new Error(
      `활성화되지 않았거나 없는 스킬이다냥: ${skillName}. 가능한 스킬은 ${activeSkills.map((item) => item.name).join(", ")} 이다냥.`,
    );
  }

  const reportAccessStatus = await fetchReportAccessStatus({
    discordUserId: interaction.user.id,
  });
  if (!reportAccessStatus.allowed) {
    await interaction.reply({
      content:
        reportAccessStatus.reason || "현재 \`/report\`를 사용할 수 없다냥.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let runLock = null;

  try {
    runLock = await acquireChannelRunLock(channelKey, interaction.commandName);
    if (!runLock.acquired) {
      const existingCommandName =
        runLock.metadata?.commandName || interaction.commandName;
      const message = `이 채널에서는 이미 \`/${existingCommandName}\` 실행이 돌아가고 있다냥. 끝난 뒤에 다시 시도해달라냥.`;
      await interaction
        .reply({ content: message, flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }

    activeChannelRuns.set(channelKey, {
      commandName: interaction.commandName,
      startedAt: Date.now(),
    });

    await interaction.deferReply();
    const startedAt = Date.now();
    const {
      snapshot: benchmarkSnapshot,
      promptContext: benchmarkContext,
    } = await loadReportBenchmarkContext();
    const cacheDescriptor = buildReportCacheDescriptor({
      skillName: skill.name,
      question,
      marketSnapshotDate: benchmarkSnapshot.marketSession?.tradingDate || "",
      marketSessionState: benchmarkSnapshot.marketSession?.session || "",
      reportMode: "default",
    });

    if (
      await tryServeCachedReport({
        interaction,
        skill,
        cacheDescriptor,
        startedAt,
      })
    ) {
      return;
    }

    if (!hasCapability("report-worker")) {
      await handleDispatchedReport({
        interaction,
        skill,
        question,
        startedAt,
        cacheDescriptor,
      });
      return;
    }

    const { runDir } = createReportRun(skill.name);
    const artifactPaths = buildResearchArtifactPaths(runDir);
    const guardJob = await runGuardStage({
      skill,
      question,
      runDir,
    });

    if (guardJob.code !== 0) {
      throw new Error(
        guardJob.stderr || `사전 검사 단계가 ${guardJob.code} 코드로 끝났다냥.`,
      );
    }

    if (!guardJob.result) {
      throw new Error("사전 검사 결과를 제대로 받지 못했다냥.");
    }

    if (!guardJob.result.allow) {
      await interaction.editReply({
        content: toNyangSentence(
          guardJob.result.reason,
          "이 질문은 사전 검사에서 통과하지 못했다냥.",
        ),
      });
      return;
    }

    const accessGrant = await grantReportAccess({
      discordUserId: interaction.user.id,
    });
    if (!accessGrant.allowed) {
      await interaction.editReply({
        content: accessGrant.reason || "현재 \`/report\`를 사용할 수 없다냥.",
      });
      return;
    }

    await interaction.editReply({
      content:
        accessGrant.access_type === "free_once_consumed"
          ? "무료 \`/report\` 1회를 사용한다냥. 리포트를 채널에 올리고 있다냥. 아래 메시지를 봐달라냥."
          : "리포트를 채널에 올리고 있다냥. 아래 메시지를 봐달라냥.",
    });

    await ensureArtifactParentDirs(artifactPaths);

    let currentProgress = {
      status: "starting",
      phase: "research",
      skillName: skill.name,
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    };
    let researchPhaseCounts = {
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    };
    let lastPublishedMessage = "";
    let progressUpdateInFlight = false;
    let progressUpdatesEnabled = true;
    const progressMessage = await createProgressMessage(
      interaction,
      buildProgressMessage(currentProgress),
    );
    lastPublishedMessage = buildProgressMessage(currentProgress);

    const publishProgress = async () => {
      if (!progressUpdatesEnabled || progressUpdateInFlight) {
        return;
      }

      const nextMessage = buildProgressMessage(currentProgress);
      if (nextMessage === lastPublishedMessage) {
        return;
      }

      progressUpdateInFlight = true;
      try {
        await editProgressMessage(progressMessage, {
          content: nextMessage,
        });
        lastPublishedMessage = nextMessage;
      } catch (error) {
        progressUpdatesEnabled = false;
        console.error("Failed to publish Discord progress update:", error);
      } finally {
        progressUpdateInFlight = false;
      }
    };

    const progressTimer = setInterval(() => {
      void publishProgress();
    }, 12_000);

    let researchJob;
    let reportJob;
    let researchMarkdown = "";
    let aggregateCounts = {
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    };

    try {
      const runProducerStageWithValidation = async ({
        stageName,
        expectedPaths,
      }) => {
        let stageCounts = {
          webSearchCount: 0,
          financeLookupCount: 0,
          chartAnalysisCount: 0,
        };

        const job = await runProducerStage({
          stageName,
          skill,
          question,
          artifactPaths,
          runDir,
          onEvent: async (progress) => {
            stageCounts = {
              webSearchCount: progress.webSearchCount || 0,
              financeLookupCount: progress.financeLookupCount || 0,
              chartAnalysisCount: progress.chartAnalysisCount || 0,
            };
            currentProgress = {
              ...progress,
              phase: "research",
              skillName: skill.name,
              webSearchCount:
                aggregateCounts.webSearchCount + stageCounts.webSearchCount,
              financeLookupCount:
                aggregateCounts.financeLookupCount +
                stageCounts.financeLookupCount,
              chartAnalysisCount:
                aggregateCounts.chartAnalysisCount +
                stageCounts.chartAnalysisCount,
            };
            await publishProgress();
          },
        });

        if (job.code !== 0) {
          throw new Error(
            job.stderr || `${stageName} 단계가 ${job.code} 코드로 끝났다냥.`,
          );
        }

        if (!job.result) {
          throw new Error(`${stageName} 결과를 제대로 받지 못했다냥.`);
        }

        if (job.result.status !== "ok") {
          throw new Error(
            job.result.error || `${stageName} 단계에서 문제가 생겼다냥.`,
          );
        }

        await validateArtifactPathsExist(expectedPaths);
        aggregateCounts = {
          webSearchCount:
            aggregateCounts.webSearchCount + stageCounts.webSearchCount,
          financeLookupCount:
            aggregateCounts.financeLookupCount + stageCounts.financeLookupCount,
          chartAnalysisCount:
            aggregateCounts.chartAnalysisCount +
            stageCounts.chartAnalysisCount,
        };
      };

      await runProducerStageWithValidation({
        stageName: "policy-search",
        expectedPaths: [
          artifactPaths.policyMarkdownPath,
          artifactPaths.policyFactsPath,
        ],
      });

      await runProducerStageWithValidation({
        stageName: "tech-social-search",
        expectedPaths: [
          artifactPaths.techSocialMarkdownPath,
          artifactPaths.techSocialSignalsPath,
        ],
      });

      await runProducerStageWithValidation({
        stageName: "scan-producer",
        expectedPaths: [
          artifactPaths.scanManifestJsonPath,
          artifactPaths.scanSummaryMarkdownPath,
          artifactPaths.candidateTickersJsonPath,
        ],
      });

      currentProgress = {
        status: "running",
        phase: "chart",
        skillName: skill.name,
        activeStepIndex: null,
        totalSteps: null,
        activeStepText:
          "후보 티커 JSON을 읽어 일봉과 주봉 차트를 생산하고 있다냥.",
        webSearchCount: aggregateCounts.webSearchCount,
        financeLookupCount: aggregateCounts.financeLookupCount,
        chartAnalysisCount: aggregateCounts.chartAnalysisCount,
      };
      await publishProgress();

      const chartCandidates = await produceCandidateCharts({
        consumeChartQueueBatch,
        runDir,
        candidateTickersJsonPath: artifactPaths.candidateTickersJsonPath,
        outRoot: artifactPaths.candidateChartRootDir,
        timeframes: ["D"],
      });

      await validateArtifactPathsExist([artifactPaths.candidateChartManifestPath]);
      aggregateCounts = {
        ...aggregateCounts,
        chartAnalysisCount:
          aggregateCounts.chartAnalysisCount + chartCandidates.symbols.length,
      };

      researchJob = await runResearchStage({
        skill,
        question,
        runDir,
        artifactPaths,
        benchmarkContext,
        onEvent: async (progress) => {
          researchPhaseCounts = {
            webSearchCount:
              aggregateCounts.webSearchCount + (progress.webSearchCount || 0),
            financeLookupCount:
              aggregateCounts.financeLookupCount +
              (progress.financeLookupCount || 0),
            chartAnalysisCount:
              aggregateCounts.chartAnalysisCount +
              (progress.chartAnalysisCount || 0),
          };
          currentProgress = {
            ...progress,
            phase: "research",
            skillName: skill.name,
            ...researchPhaseCounts,
          };
          await publishProgress();
        },
      });

      if (researchJob.code !== 0) {
        throw new Error(
          researchJob.stderr ||
            `리서치 단계가 ${researchJob.code} 코드로 끝났다냥.`,
        );
      }

      if (!researchJob.result) {
        throw new Error("리서치 결과를 제대로 받지 못했다냥.");
      }

      if (researchJob.result.status !== "ok") {
        throw new Error(
          researchJob.result.error || "리서치 단계에서 문제가 생겼다냥.",
        );
      }

      researchMarkdown = await resolveResearchMarkdown(runDir, researchJob);
      const researchMarkdownPath = path.join(runDir, "research.md");
      await fs.writeFile(researchMarkdownPath, researchMarkdown, "utf8");

      currentProgress = {
        status: "running",
        phase: "report",
        skillName: skill.name,
        webSearchCount: researchPhaseCounts.webSearchCount,
        financeLookupCount: researchPhaseCounts.financeLookupCount,
        chartAnalysisCount: researchPhaseCounts.chartAnalysisCount,
      };
      await publishProgress();

      reportJob = await runReportStage({
        skill,
        analysisMarkdown: researchMarkdown,
        runDir,
        onEvent: async (progress) => {
          currentProgress = {
            ...progress,
            phase: "report",
            skillName: skill.name,
            webSearchCount:
              researchPhaseCounts.webSearchCount +
              (progress.webSearchCount || 0),
            financeLookupCount:
              researchPhaseCounts.financeLookupCount +
              (progress.financeLookupCount || 0),
            chartAnalysisCount:
              researchPhaseCounts.chartAnalysisCount +
              (progress.chartAnalysisCount || 0),
          };
          await publishProgress();
        },
      });
    } finally {
      clearInterval(progressTimer);
    }

    if (reportJob.code !== 0) {
      throw new Error(
        reportJob.stderr || `리포트 단계가 ${reportJob.code} 코드로 끝났다냥.`,
      );
    }

    if (!reportJob.result) {
      throw new Error("리포트 결과를 제대로 받지 못했다냥.");
    }

    if (reportJob.result.status !== "ok") {
      throw new Error(
        reportJob.result.error || "리포트 단계에서 문제가 생겼다냥.",
      );
    }

    await validateReportArtifacts(runDir, reportJob.result.report);
    await putReportCache({
      cacheKey: cacheDescriptor.cacheKey,
      discordUserId: interaction.user.id,
      skill: skill.name,
      questionNormalized: cacheDescriptor.questionNormalized,
      questionHash: cacheDescriptor.questionHash,
      marketSnapshotDate: cacheDescriptor.marketSnapshotDate,
      marketSessionState: cacheDescriptor.marketSessionState,
      reportMode: cacheDescriptor.reportMode,
      runDir,
      result: {
        report: serializeReportArtifacts(runDir, reportJob.result.report),
        metrics: {
          webSearchCount: currentProgress.webSearchCount || 0,
          financeLookupCount: currentProgress.financeLookupCount || 0,
          chartAnalysisCount: currentProgress.chartAnalysisCount || 0,
        },
      },
      expiresAt: new Date(Date.now() + REPORT_CACHE_TTL_MS).toISOString(),
    });
    const postingChannel = await resolvePostingChannel(interaction);

    const attachments = await loadAttachments(reportJob.result.report.png_paths);
    const finalMessageBase = [
      `리포트 완성이다냥! (${skill.name}, 소요시간: ${formatElapsedDuration(startedAt)})`,
      buildMetricsLine(currentProgress),
    ].join("\n");
    const finalMessage = [finalMessageBase, "벤치마크 결과를 기다린다냥."].join(
      "\n",
    );

    const deliveredMessage = await editProgressMessage(progressMessage, {
      content: finalMessage,
      files: attachments,
    }).catch(async (error) => {
      console.error(
        "Failed to edit progress message with final report, attempting fresh channel post:",
        error,
      );
      return postingChannel.send({
        content: finalMessage,
        files: attachments,
      });
    });

    void enqueueBenchmarkFollowup(
      {
        runDir,
        skill: {
          name: skill.name,
          mention: skill.mention,
        },
        researchMarkdownPath: path.join(runDir, "research.md"),
        reportMessageChannelId:
          deliveredMessage?.channelId || interaction.channelId || "",
        reportMessageId: deliveredMessage?.id || "",
        reportMessageBaseContent: finalMessageBase,
      },
      consumeBenchmarkQueueBatch,
    ).catch((queueError) => {
      console.error("Failed to enqueue benchmark report:", queueError);
    });
  } catch (error) {
    const publicMessage =
      "문제가 생겨서 이번 리포트를 끝내지 못했다냥. 잠시 뒤에 다시 시도해달라냥.";

    await resolvePostingChannel(interaction)
      .then((channel) => channel.send({ content: publicMessage }))
      .catch((sendError) => {
        console.error("Failed to deliver Discord error message:", sendError);
      });

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: publicMessage }).catch(() => {});
      return;
    }

    await interaction.reply({
      content: publicMessage,
      flags: MessageFlags.Ephemeral,
    });
  } finally {
    activeChannelRuns.delete(channelKey);
    await runLock?.release().catch(() => {});
  }
}
