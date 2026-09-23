import { useEffect, useState } from "react";
import {
  createUuid,
  VM_RESOURCE_SPEC_LIMITS,
  type VmHostResources,
  type VmResourceSpec,
} from "@zcode/shared";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useVmHostResources } from "@/hooks/useVmHostResources.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

/**
 Spec-adjustment panel for an existing VM.
 *
 Specs only take effect at creation; resizing means an agent-vm --reset re-clone + re-pinned port,
 taking as long as a first create; the mounted project directory is unaffected. Current specs come from the limactl instance facts
 (the marker can drift, see R5); the marker's spec fields refresh naturally on the next reconnect persist.
 Re-clone logs stream through RemoteConnectionLog (requestId-filtered) and show progress inline in the panel.
 */
export function VmSettingsDialog({
  open,
  onOpenChange,
  workspacePath,
  onReconfigured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  onReconfigured?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [hostResources, setHostResources] = useState<VmHostResources | null>(null);
  const [currentSpec, setCurrentSpec] = useState<VmResourceSpec>({});
  const [memoryGb, setMemoryGb] = useState(3);
  const [cpus, setCpus] = useState(1);
  const [diskGb, setDiskGb] = useState(10);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [applyRequestId, setApplyRequestId] = useState<string | null>(null);
  const { connectionLogs } = useRemoteConnectionLogs(applyRequestId);
  // Poll host resources while open (5s, plan-vm-specs 2.7): the panel waits while the user tunes specs repeatedly,
  // where a one-shot snapshot goes stale. On failure keep the last snapshot (if the first fetch fails, the line stays hidden), matching prior behavior.
  useVmHostResources({
    enabled: open,
    onResources: setHostResources,
    onError: (error) => {
      logger.warn("[VmSettingsDialog] hostResources 查询失败", {
        error: getErrorMessage(error),
      });
    },
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    setApplyError("");
    setApplying(false);
    setApplyRequestId(null);
    // On open, fetch the instance's live specs: the marker can drift; limactl facts are the baseline (R5).
    if (platform.vmStatus) {
      void platform
        .vmStatus({ workspacePath })
        .then((status) => {
          const next: VmResourceSpec = {
            memoryGb: status.memoryGb,
            cpus: status.cpus,
            diskGb: status.diskGb,
          };
          setCurrentSpec(next);
          setMemoryGb(next.memoryGb ?? 3);
          setCpus(next.cpus ?? 1);
          setDiskGb(next.diskGb ?? 10);
        })
        .catch((error) => {
          logger.warn("[VmSettingsDialog] vmStatus 查询失败", {
            error: getErrorMessage(error),
          });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialize once on open
  }, [open]);

  const dirty =
    memoryGb !== (currentSpec.memoryGb ?? 3) ||
    cpus !== (currentSpec.cpus ?? 1) ||
    diskGb !== (currentSpec.diskGb ?? 10);

  const overMemory =
    hostResources !== null && memoryGb > Math.max(0, hostResources.availableMemoryGb);
  const overCpus = hostResources !== null && cpus > hostResources.logicalCpus;

  const handleApply = async () => {
    if (!platform.vmReconfigure || applying) {
      return;
    }
    setApplying(true);
    setApplyError("");
    const requestId = createUuid();
    setApplyRequestId(requestId);
    try {
      const spec: VmResourceSpec = { memoryGb, cpus, diskGb };
      const result = await platform.vmReconfigure({
        workspacePath,
        spec,
        requestId,
      });
      if (!result.success) {
        setApplyError(result.error || intl.formatMessage({ id: "vm.specs.applyFailed" }));
        return;
      }
      onReconfigured?.();
      onOpenChange(false);
    } catch (error) {
      setApplyError(getErrorMessage(error));
    } finally {
      setApplying(false);
    }
  };

  const numberField = (
    labelId: string,
    value: number,
    onChange: (next: number) => void,
    limits: { min: number; max: number },
    suffix: string,
    disabled: boolean,
  ) => (
    <label className="flex min-w-28 flex-col gap-1 text-ui-sm text-foreground-subtle">
      <span>{intl.formatMessage({ id: labelId })}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          value={value}
          min={limits.min}
          max={limits.max}
          step={1}
          disabled={disabled}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(next)) {
              onChange(Math.min(limits.max, Math.max(limits.min, next)));
            }
          }}
          className="h-8 w-20 rounded-md border border-border bg-background px-2 text-ui-base text-foreground outline-none focus-visible:border-primary disabled:opacity-60"
          data-testid={`vm-settings-${labelId.split(".").pop()}`}
        />
        <span className="text-ui-sm">{suffix}</span>
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg rounded-2xl p-0">
        <DialogHeader className="px-6 pt-6">
          <span className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "vm.specs.title" })}
          </span>
          <span className="break-all text-ui-sm text-foreground-subtle">{workspacePath}</span>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          {hostResources ? (
            <div className="rounded-xl border border-border bg-surface px-4 py-3 text-ui-sm text-foreground-subtle">
              <div>
                {intl.formatMessage(
                  { id: "vm.specs.hostLine" },
                  {
                    available: hostResources.availableMemoryGb.toFixed(1),
                    total: hostResources.totalMemoryGb.toFixed(1),
                    cpus: String(hostResources.logicalCpus),
                    disk: hostResources.diskFreeGb.toFixed(0),
                  },
                )}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-4">
            {numberField(
              "vm.specs.memory",
              memoryGb,
              setMemoryGb,
              VM_RESOURCE_SPEC_LIMITS.memoryGb,
              "GB",
              applying,
            )}
            {numberField(
              "vm.specs.cpus",
              cpus,
              setCpus,
              VM_RESOURCE_SPEC_LIMITS.cpus,
              intl.formatMessage({ id: "vm.specs.cpuUnit" }),
              applying,
            )}
            {numberField(
              "vm.specs.disk",
              diskGb,
              setDiskGb,
              VM_RESOURCE_SPEC_LIMITS.diskGb,
              "GB",
              applying,
            )}
          </div>

          {overMemory ? (
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-sm text-warning">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {intl.formatMessage(
                { id: "vm.specs.overMemory" },
                {
                  available: (hostResources?.availableMemoryGb ?? 0).toFixed(1),
                },
              )}
            </div>
          ) : null}
          {overCpus ? (
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-sm text-warning">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {intl.formatMessage(
                { id: "vm.specs.overCpus" },
                { cpus: String(hostResources?.logicalCpus ?? 0) },
              )}
            </div>
          ) : null}

          {dirty && !applying ? (
            <div className="rounded-lg bg-warning/10 px-3 py-2 text-ui-sm text-warning">
              {intl.formatMessage({ id: "vm.specs.recreateWarning" })}
            </div>
          ) : null}

          {applyRequestId && connectionLogs.length > 0 ? (
            <pre className="max-h-32 overflow-auto rounded-lg border border-border bg-background-alt px-3 py-2 font-mono text-ui-xs/relaxed text-foreground-subtle">
              {connectionLogs
                .slice(-8)
                .map((entry) => entry.message)
                .join("\n")}
            </pre>
          ) : null}

          {applyError ? (
            <div className="rounded-lg bg-destructive px-3 py-2 text-ui-sm text-destructive-foreground">
              {applyError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={applying}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!dirty || applying || !platform.vmReconfigure}
              data-testid="vm-settings-apply"
              onClick={() => {
                void handleApply();
              }}
            >
              {applying
                ? intl.formatMessage({ id: "vm.specs.applying" })
                : intl.formatMessage({ id: "vm.specs.applyRecreate" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
