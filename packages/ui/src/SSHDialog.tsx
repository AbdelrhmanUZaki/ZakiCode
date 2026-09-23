/* eslint-disable max-lines -- 远程连接向导的状态编排暂集中在同一组件，后续有独立拆分计划。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createUuid,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type VmHostResources,
  type VmResourceSpec,
  type VmRuntimeEndpoint,
  type VmTemplateToolsChoice,
} from "@zcode/shared";
import {
  TID_SSH_CONNECT_TRIGGER,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
} from "@zcode/shared";
import { AlertTriangleIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useVmHostResources } from "@/hooks/useVmHostResources.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  buildRemoteTarget,
  getRemoteWizardStepCopy,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  isRemoteConnectionFlowActive,
  shouldResetRemoteConnectionOnOpen,
} from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import {
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionKindStep,
  RemoteConnectionSettingsStep,
} from "@/RemoteConnectionDialogContent.js";
import { RemoteConnectionVmSpecStep } from "@/remote-connection/RemoteConnectionVmSpecStep.js";
import {
  RemoteConnectionWizardHeader,
  RemoteConnectionWizardSidebar,
  type RemoteWizardStep,
} from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { VariantProps } from "class-variance-authority";

interface RemoteConnectionDialogProps {
  onConnect: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectProject: (sessionId: string, path: string, localWorkspacePath?: string) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  localWorkspacePath?: string;
  trigger?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTriggerWhenClosed?: boolean;
  isWindowsDesktop?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
  /**
   * VM mode entry: given a host project directory, skip the kind/settings wizard and go
   * straight to ensureUp (agent-vm) → connect → auto-select the workspace at the same path (live mount).
   */
  vmWorkspacePath?: string | null;
}

export function RemoteConnectionDialog({
  onConnect,
  onSelectProject,
  onCancelSession,
  localWorkspacePath,
  trigger,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  hideTriggerWhenClosed = false,
  isWindowsDesktop = false,
  remoteWorkspaceSessions = [],
  onFlowActiveChange,
  onFlowRequestIdChange,
  preferredKind,
  preferredWslDistro,
  vmWorkspacePath,
}: RemoteConnectionDialogProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const confirmDialog = useConfirmDialog();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [currentStep, setCurrentStep] = useState<RemoteWizardStep>("kind");
  const [connectedSessionId, setConnectedSessionId] = useState<string | null>(null);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  // The VM boot flow may auto-trigger once; reset on close so reopening does not instantly boot again.
  const vmFlowStartedRef = useRef(false);
  // Remembers the directory whose boot last started; a change means a new flow, force-clearing vmFlowStartedRef.
  const vmStartedPathRef = useRef<string | null>(null);
  // Spec panel data for a first create; when set, the connecting step renders the panel instead of the log stream.
  // templateReady comes from vmStatus (machine-level fact): with the base image missing, the panel shows a one-time build notice.
  const [vmSpecPanel, setVmSpecPanel] = useState<{
    hostResources: VmHostResources;
    templateReady: boolean;
  } | null>(null);
  // The spec the panel confirmed: reused on boot retry instead of asking again.
  const lastVmSpecRef = useRef<VmResourceSpec | undefined>(undefined);
  const { connectionLogs, resetConnectionLogs } = useRemoteConnectionLogs(connectingRequestId);
  const open = controlledOpen ?? uncontrolledOpen;
  const vmMode = Boolean(vmWorkspacePath);
  // Poll host resources while the spec panel is open (5s, plan-vm-specs 2.7): the panel waits on the user
  // indefinitely, and a stale snapshot would size against outdated headroom. setVmSpecPanel stays the single write path.
  useVmHostResources({
    enabled: vmMode && vmSpecPanel !== null,
    onResources: (resources) => {
      setVmSpecPanel((panel) => (panel ? { ...panel, hostResources: resources } : panel));
    },
  });
  const {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
  } = useRemoteConnectionForm({
    open,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
  });
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  const flowActive = isRemoteConnectionFlowActive(flowSnapshot);

  useEffect(() => {
    onFlowActiveChange?.(flowActive);
  }, [flowActive, onFlowActiveChange]);

  useEffect(() => {
    // Backstop: a new VM directory means a new flow; even if a completion/cancel path forgets to clear
    // vmFlowStartedRef, this force-clears it on path change so auto-start always fires.
    // Must be declared before the auto-start effect below: clear first, then evaluate, within one commit.
    if (vmWorkspacePath && vmWorkspacePath !== vmStartedPathRef.current) {
      vmStartedPathRef.current = vmWorkspacePath;
      vmFlowStartedRef.current = false;
      lastVmSpecRef.current = undefined;
    }
    if (!vmWorkspacePath) {
      vmStartedPathRef.current = null;
    }
  }, [vmWorkspacePath]);

  useEffect(() => {
    // VM mode: bootstrap automatically on open (no click needed). The ref guards against StrictMode double-invocation.
    if (!open || !vmWorkspacePath || vmFlowStartedRef.current || currentStep !== "kind") {
      return;
    }
    vmFlowStartedRef.current = true;
    void bootstrapVmFlow(vmWorkspacePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrapVmFlow is rebuilt every render; the ref deduplicates
  }, [open, vmWorkspacePath, currentStep]);

  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [onFlowRequestIdChange],
  );

  const applyOpenState = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
  };

  const resetFeedback = () => {
    setError("");
    setValidationMessage("");
  };

  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, []);

  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      try {
        await onCancelSession(sessionId);
      } catch (sessionError) {
        logger.warn("[SSHDialog] 释放未确认的远程 session 失败:", {
          sessionId,
          error: sessionError,
        });
      }
    },
    [onCancelSession],
  );

  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean }) => {
      const sessionId = connectedSessionId;
      if (!options?.preserveSession && sessionId) {
        void handleCancelSession(sessionId);
      } else if (!options?.preserveSession && loading && currentStep === "connecting") {
        // 连接过程里 sessionId 尚未返回时，关闭弹窗会只重置 UI；这里补上显式取消，确保后台下载同步停止。
        void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
      }
      resetFeedback();
      setLoading(false);
      resetDirectorySelectionState();
      resetConnectionLogs();
      setCurrentStep("kind");
      setConnectedSessionId(null);
      setPendingRemoteTarget(null);
      vmFlowStartedRef.current = false;
      setVmSpecPanel(null);
      updateConnectingRequestId(null);
      applyOpenState(false);
    },
    [
      cancelPendingRemoteConnection,
      connectedSessionId,
      connectingRequestId,
      currentStep,
      handleCancelSession,
      loading,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const confirmRemoteFlowDiscard = useCallback(async () => {
    if (currentStep === "connecting" && loading) {
      return confirmDialog({
        title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
        description: intl.formatMessage({
          id: "remote.connectingConfirmDescription",
        }),
        confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
    }
    if (!connectedSessionId) {
      return true;
    }
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectedConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }, [confirmDialog, connectedSessionId, currentStep, intl, loading]);

  const handleCloseRequest = useCallback(async () => {
    const confirmed = await confirmRemoteFlowDiscard();
    if (!confirmed) {
      return;
    }
    closeDialog();
  }, [closeDialog, confirmRemoteFlowDiscard]);

  const startRemoteConnection = async (target: RemoteTarget) => {
    const nextTarget = withDefaultRemoteResourcePackages(target);

    if (loading) {
      // React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    setPendingRemoteTarget(nextTarget);
    setLoading(true);
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    resetConnectionLogs();
    setCurrentStep("connecting");
    const trace = startUserAction({
      featureId: "workspace.remote.lifecycle",
      action: "connect",
      trigger: "button",
      workspaceKind: "remote",
      remoteKind: nextTarget.kind,
    });
    try {
      const sessionId = await onConnect(nextTarget, requestId);
      const completionState = getRemoteConnectionCompletionDialogState("success");
      setConnectedSessionId(sessionId);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
      trace.complete({ resultSource: "platform_result" });
    } catch (connectError) {
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const errorMessage = getErrorMessage(connectError);
      setError(errorMessage);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
      trace.fail({ failureStage: "remote_connect" });
    } finally {
      setLoading(false);
    }
  };

  const buildVmRemoteTarget = (endpoint: VmRuntimeEndpoint, spec?: VmResourceSpec): RemoteTarget =>
    withDefaultRemoteResourcePackages({
      kind: "ssh",
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      sshConfigAlias: endpoint.alias,
      privateKeyPath: endpoint.privateKeyPath,
      assetInstallMode: "local-download-upload",
      // Spec fields are held by the initiator (this panel / settings panel) and persisted with the marker; reconnect ignores them.
      vm: {
        provider: "agent-vm",
        vmName: endpoint.vm,
        ...(spec?.memoryGb !== undefined ? { memoryGb: spec.memoryGb } : {}),
        ...(spec?.cpus !== undefined ? { cpus: spec.cpus } : {}),
        ...(spec?.diskGb !== undefined ? { diskGb: spec.diskGb } : {}),
      },
    });

  // VM flow: ensureUp boot logs and the SSH connection logs share one requestId, so the connecting
  // step's log panel shows the full timeline of VM boot → connection in order.
  const startVmRemoteConnection = async (
    workspacePath: string,
    spec?: VmResourceSpec,
    templateTools?: VmTemplateToolsChoice,
  ) => {
    if (loading) {
      return;
    }
    const vmEnsureUp = platform.vmEnsureUp;
    if (!vmEnsureUp) {
      setError(intl.formatMessage({ id: "vm.runtime.unavailable" }));
      return;
    }

    setLoading(true);
    setVmSpecPanel(null);
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    resetConnectionLogs();
    setCurrentStep("connecting");
    try {
      const boot = await vmEnsureUp({
        workspacePath,
        requestId,
        spec,
        templateTools,
      });
      if (!boot.success || !boot.endpoint) {
        throw new Error(boot.error || intl.formatMessage({ id: "vm.runtime.bootFailed" }));
      }
      const nextTarget = buildVmRemoteTarget(boot.endpoint, spec);
      setPendingRemoteTarget(nextTarget);
      const sessionId = await onConnect(nextTarget, requestId);
      const completionState = getRemoteConnectionCompletionDialogState("success");
      setConnectedSessionId(sessionId);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
    } catch (vmFlowError) {
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const errorMessage = getErrorMessage(vmFlowError);
      setError(errorMessage);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
    } finally {
      setLoading(false);
    }
  };

  // VM bootstrap: probe whether the VM exists — if not (first create), show the spec panel first so the
  // user makes the one-time sizing decision against real host headroom; if it exists, keep the zero-click direct start.
  const bootstrapVmFlow = async (workspacePath: string) => {
    const vmStatusQuery = platform.vmStatus;
    if (!vmStatusQuery || !platform.vmHostResources) {
      void startVmRemoteConnection(workspacePath);
      return;
    }
    setLoading(true);
    setCurrentStep("connecting");
    try {
      const status = await vmStatusQuery({ workspacePath });
      if (status.state === "none") {
        const hostResources = await platform.vmHostResources();
        // The panel waits for the user, so loading must clear first or Start gets blocked by the concurrency guard.
        setLoading(false);
        setVmSpecPanel({
          hostResources,
          templateReady: status.templateReady ?? true,
        });
        return;
      }
    } catch {
      // // Probe failure is treated as an existing VM: go straight to ensureUp (idempotent, self-heals most states).
    }
    void startVmRemoteConnection(workspacePath);
  };

  const handleConnect = async () => {
    if (loading) {
      // React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    const { target: nextTarget, errorMessage } = buildRemoteTarget(intl, {
      kind,
      host,
      port,
      username,
      sshAuthMethod,
      assetInstallMode,
      password,
      privateKeyPath,
      privateKeyPassphrase,
      selectedSshConfigAlias,
      wslDistro,
      wslUser,
      dockerContainer,
      manualDockerContainer,
    });
    if (!nextTarget) {
      // 必填项缺失属于表单校验，不应该和真实连接失败共用 destructive 错误样式。
      // 这里单独落到 settings 步骤内的 warning 提示，用户能更快理解是“缺少输入”而不是“连接出错”。
      setValidationMessage(errorMessage ?? "Connection failed");
      return;
    }

    resetFeedback();
    setPendingRemoteTarget(nextTarget);
    await startRemoteConnection(nextTarget);
  };

  const handleStartPendingRemoteConnection = useCallback(() => {
    if (!pendingRemoteTarget) {
      void handleConnect();
      return;
    }

    void startRemoteConnection(pendingRemoteTarget);
  }, [handleConnect, pendingRemoteTarget, startRemoteConnection]);

  const handleBackToConnection = useCallback(async () => {
    if (!connectedSessionId) {
      return;
    }

    resetFeedback();
    try {
      await onCancelSession(connectedSessionId);
      setConnectedSessionId(null);
      updateConnectingRequestId(null);
      resetConnectionLogs();
      setCurrentStep("settings");
    } catch (sessionError) {
      setError(getErrorMessage(sessionError));
    }
  }, [connectedSessionId, onCancelSession, updateConnectingRequestId]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      if (!connectedSessionId || selectingDirectoryRef.current) {
        return;
      }

      // 选中远程目录后还要做 realpath、provider 同步、session 持久化和任务列表刷新。
      // 这些异步步骤之前没有独立的提交中状态，用户会看到按钮无响应；这里在入口设置状态并用 ref 防重复提交。
      selectingDirectoryRef.current = true;
      setSelectingDirectory(true);
      resetFeedback();
      try {
        await onSelectProject(connectedSessionId, path, localWorkspacePath);
        resetConnectionLogs();
        setCurrentStep("kind");
        setConnectedSessionId(null);
        setPendingRemoteTarget(null);
        // The VM flow's completion path bypasses closeDialog; the one-shot flag must be cleared here,
        // otherwise a second Open-folder-in-VM is blocked by the stale ref and the dialog opens on a blank kind step.
        vmFlowStartedRef.current = false;
        setVmSpecPanel(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      } catch (selectionError) {
        const failureState = getRemoteConnectionDirectoryFailureState({
          connectedSessionId,
          // 事件处理器只在失败时读取一次最新 snapshot，避免为了回调判断新增重复 Zustand 订阅。
          sessionStillRegistered: Boolean(
            useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
          ),
        });
        if (!failureState.connectedSessionId) {
          setConnectedSessionId(null);
          setCurrentStep(failureState.step);
          updateConnectingRequestId(null);
        }
        setError(getErrorMessage(selectionError));
      } finally {
        resetDirectorySelectionState();
      }
    },
    [
      connectedSessionId,
      localWorkspacePath,
      onSelectProject,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const vmWorkspaceAutoSelectPath = vmMode ? vmWorkspacePath : null;
  useEffect(() => {
    // // The VM is a same-path live mount: after connecting, select the workspace at the host path directly, skipping the remote directory browser.
    // // Relies on handleSelectDirectory committing connectedSessionId; the effect picks up the non-empty sessionId on the next tick.
    if (currentStep !== "directory" || !connectedSessionId || !vmWorkspaceAutoSelectPath) {
      return;
    }
    void handleSelectDirectory(vmWorkspaceAutoSelectPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSelectDirectory's deps are covered by currentStep/connectedSessionId
  }, [currentStep, connectedSessionId, vmWorkspaceAutoSelectPath]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
        resetFeedback();
        resetConnectionLogs();
        setCurrentStep("kind");
        setPendingRemoteTarget(null);
      }
      applyOpenState(true);
      return;
    }

    void handleCloseRequest();
  };

  const stepCopy = getRemoteWizardStepCopy(intl, currentStep, kind);

  return (
    <>
      {!hideTriggerWhenClosed ? (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          onClick={() => {
            if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
              resetFeedback();
              resetConnectionLogs();
              setCurrentStep("kind");
              setPendingRemoteTarget(null);
            }
            applyOpenState(true);
          }}
          data-testid={TID_SSH_CONNECT_TRIGGER}
          className={triggerClassName}
        >
          {trigger ?? intl.formatMessage({ id: "remote.trigger" })}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100dvh-1rem)] max-h-168 w-[calc(100vw-1rem)] max-w-4xl overflow-hidden rounded-2xl p-0 md:h-[calc(100vh-6rem)]"
        >
          <div
            data-testid={TID_SSH_DIALOG}
            className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row"
          >
            <RemoteConnectionWizardSidebar currentStep={currentStep} />

            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:gap-4 sm:p-6">
              <DialogHeader className="space-y-2">
                <RemoteConnectionWizardHeader
                  title={stepCopy.title}
                  description={stepCopy.description}
                  onMinimize={
                    flowActive
                      ? () => {
                          // 连接慢时用户只能关闭弹窗，关闭会取消 pending 连接并丢失当前步骤。
                          // 这里把“收起”明确拆成仅隐藏 dialog，不重置状态、不取消后台连接，后续入口可恢复到当前步骤。
                          applyOpenState(false);
                        }
                      : undefined
                  }
                  onClose={() => {
                    // 关闭和收起的语义不同。关闭仍走确认和取消逻辑，避免已连接但未选目录的 session 泄漏。
                    void handleCloseRequest();
                  }}
                />
              </DialogHeader>

              {error && currentStep !== "connecting" ? (
                <div
                  data-testid={TID_SSH_ERROR}
                  // 远程连接的错误提示以前直接拼接颜色 token，和全局状态反馈样式不一致。
                  // 这里统一改成 destructive 语义色对，避免 SSH/Docker 两种模式出现不同的错误视觉。
                  className="flex items-start gap-3 rounded-xl bg-destructive px-4 py-3 text-ui-base text-destructive-foreground"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  {error}
                </div>
              ) : null}

              <div className="w-full min-h-0 flex-1">
                {currentStep === "kind" && !vmMode ? (
                  <RemoteConnectionKindStep
                    kind={kind}
                    availableKinds={availableKinds}
                    onKindChange={setKind}
                    onCancel={() => closeDialog()}
                    onNext={() => {
                      resetFeedback();
                      setCurrentStep("settings");
                    }}
                  />
                ) : null}

                {currentStep === "settings" ? (
                  <RemoteConnectionSettingsStep
                    kind={kind}
                    host={host}
                    port={port}
                    username={username}
                    sshAuthMethod={sshAuthMethod}
                    assetInstallMode={assetInstallMode}
                    password={password}
                    privateKeyPath={privateKeyPath}
                    privateKeyPassphrase={privateKeyPassphrase}
                    wslDistro={wslDistro}
                    wslUser={wslUser}
                    wslDistros={wslDistros}
                    dockerContainer={dockerContainer}
                    manualDockerContainer={manualDockerContainer}
                    dockerContainers={dockerContainers}
                    dockerAvailable={dockerAvailable}
                    sshConfigAliases={sshConfigAliases}
                    sshConfigAliasesLoading={sshConfigAliasesLoading}
                    sshConfigAliasesError={sshConfigAliasesError}
                    selectedSshConfigAlias={selectedSshConfigAlias}
                    currentRuntimeOptionsLoading={currentRuntimeOptionsLoading}
                    currentRuntimeOptionsError={currentRuntimeOptionsError}
                    remoteWorkspaceSessions={remoteWorkspaceSessions}
                    validationMessage={validationMessage}
                    loading={loading}
                    onBack={() => {
                      resetFeedback();
                      setCurrentStep("kind");
                    }}
                    onHostChange={setHost}
                    onPortChange={setPort}
                    onUsernameChange={setUsername}
                    onSshAuthMethodChange={setSshAuthMethod}
                    onAssetInstallModeChange={setAssetInstallMode}
                    onPasswordChange={setPassword}
                    onPrivateKeyPathChange={setPrivateKeyPath}
                    onPrivateKeyPassphraseChange={setPrivateKeyPassphrase}
                    onWslDistroChange={setWslDistro}
                    onWslUserChange={setWslUser}
                    onDockerContainerChange={setDockerContainer}
                    onManualDockerContainerChange={setManualDockerContainer}
                    onDockerContainersRefresh={refreshDockerContainers}
                    onApplySshConfigAlias={applySshConfigAlias}
                    onClearSelectedSshConfigAlias={clearSelectedSshConfigAlias}
                    onConnect={() => {
                      void handleConnect();
                    }}
                  />
                ) : null}

                {currentStep === "connecting" && vmSpecPanel && vmMode ? (
                  <RemoteConnectionVmSpecStep
                    workspacePath={vmWorkspacePath ?? ""}
                    hostResources={vmSpecPanel.hostResources}
                    templateReady={vmSpecPanel.templateReady}
                    onStart={(spec, templateTools) => {
                      lastVmSpecRef.current = spec;
                      if (vmWorkspacePath) {
                        void startVmRemoteConnection(vmWorkspacePath, spec, templateTools);
                      }
                    }}
                    onCancel={() => {
                      void handleCloseRequest();
                    }}
                  />
                ) : null}

                {currentStep === "connecting" && !(vmSpecPanel && vmMode) ? (
                  <RemoteConnectionConnectingStep
                    kind="ssh"
                    logs={connectionLogs}
                    errorMessage={error}
                    loading={loading}
                    onBack={
                      vmMode
                        ? () => {
                            // // VM mode has no settings step to go back to; backing out abandons this boot/connect.
                            void handleCloseRequest();
                          }
                        : () => {
                            void (async () => {
                              const confirmed = await confirmRemoteFlowDiscard();
                              if (!confirmed) {
                                return;
                              }

                              if (loading) {
                                await cancelPendingRemoteConnection(
                                  connectingRequestId ?? undefined,
                                );
                                setLoading(false);
                              }
                              resetFeedback();
                              updateConnectingRequestId(null);
                              setCurrentStep("settings");
                            })();
                          }
                    }
                    onRetry={
                      vmMode
                        ? () => {
                            if (vmWorkspacePath) {
                              void startVmRemoteConnection(vmWorkspacePath, lastVmSpecRef.current);
                            }
                          }
                        : () => {
                            handleStartPendingRemoteConnection();
                          }
                    }
                  />
                ) : null}

                {currentStep === "directory" ? (
                  <div data-testid={TID_SSH_SUCCESS} className="h-full">
                    <RemoteConnectionDirectoryStep
                      services={directoryBrowserServices}
                      remoteTarget={pendingRemoteTarget}
                      localSkillSyncService={baseServices.skillSyncService}
                      remoteSkillSyncService={directoryBrowserServices?.skillSyncService ?? null}
                      localMcpSyncService={baseServices.mcpSyncService}
                      remoteMcpSyncService={directoryBrowserServices?.mcpSyncService ?? null}
                      localPluginSyncService={baseServices.pluginSyncService}
                      remotePluginSyncService={directoryBrowserServices?.pluginSyncService ?? null}
                      localZCodeAgentService={baseServices.zcodeAgentService}
                      remoteZCodeAgentService={directoryBrowserServices?.zcodeAgentService ?? null}
                      localWorkspacePath={localWorkspacePath}
                      selecting={selectingDirectory}
                      onSelect={(path) => {
                        void handleSelectDirectory(path);
                      }}
                      onBack={() => {
                        void (async () => {
                          const confirmed = await confirmRemoteFlowDiscard();
                          if (!confirmed) {
                            return;
                          }

                          await handleBackToConnection();
                        })();
                      }}
                      onCancel={() => {
                        void handleCloseRequest();
                      }}
                      onSkillsSynced={async () => undefined}
                      onMcpSynced={async () => undefined}
                      onPluginsSynced={async () => undefined}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const SSHDialog = RemoteConnectionDialog;
