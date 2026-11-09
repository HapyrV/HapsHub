using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// Notices VRChat stopping, and asks the crash rejoin module what to do about it.
public partial class AppShell
{
    private static readonly TimeSpan CrashPollInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan CrashSettleDelay = TimeSpan.FromSeconds(8);
    private System.Threading.Timer? _crashRejoinTimer;
    private bool _crashWasRunning;
    private bool _crashWasInVr;
    private string _crashLastLocation = "";

    private void StartCrashRejoinWatch()
    {
        _crashRejoinTimer = new System.Threading.Timer(_ => CheckVrcStopped(), null, CrashPollInterval, CrashPollInterval);
    }

    private void CheckVrcStopped()
    {
        try
        {
            if (!HubModules.CrashRejoin.Enabled)
            {
                _crashWasRunning = false;
                return;
            }
            var running = RelayController.IsVrcRunning();
            if (running)
            {
                _crashWasRunning = true;
                _crashWasInVr = RelayController.IsSteamVrRunning();
                var location = _logWatcher.CurrentLocation;
                if (CrashRejoinModule.IsRealInstance(location)) _crashLastLocation = location!;
                return;
            }
            if (!_crashWasRunning) return;
            _crashWasRunning = false;
            var last = _crashLastLocation;
            var vr = _crashWasInVr;
            _crashLastLocation = "";
            // SteamVR needs a moment to follow, and the log's last lines a moment to be read.
            _ = Task.Delay(CrashSettleDelay).ContinueWith(_ => RejoinIfCrashed(last, vr), TaskScheduler.Default);
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("CheckVrcStopped", ex);
        }
    }

    private void RejoinIfCrashed(string location, bool wasInVr)
    {
        try
        {
            if (RelayController.IsVrcRunning()) return;
            var decision = HubModules.CrashRejoin.DecideNow(_logWatcher.ClosedNormally, location, wasInVr, RelayController.IsSteamVrRunning());
            if (decision != CrashRejoinDecision.Rejoin) return;
            SendToJS("toast", new { ok = true, msg = "VRChat crashed. Rejoining your instance..." });
            Invoke(() => _relayCtrl.HandleMessage("vrcLaunchAndJoin", new JObject { ["location"] = location, ["vr"] = wasInVr }));
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("RejoinIfCrashed", ex);
        }
    }
}
