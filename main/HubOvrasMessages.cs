using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// OVR Advanced Settings: its movement settings, edited in its own settings file.
public partial class AppShell
{
    private bool HandleOvrasMessage(string action, JObject msg)
    {
        switch (action)
        {
            case "hubOvrasState":
                _ = Task.Run(() => SendOvrasState(""));
                return true;

            case "hubOvrasSave":
                var changes = msg["values"] as JObject;
                _ = Task.Run(() => SaveOvras(changes));
                return true;
        }
        return false;
    }

    private void SaveOvras(JObject? values)
    {
        if (OvrasSettings.IsRunning())
        {
            SendOvrasState("running");
            return;
        }
        var changes = new Dictionary<string, string>();
        foreach (var (key, token) in values ?? new JObject())
        {
            var text = token?.Type == JTokenType.Boolean
                ? (token.Value<bool>() ? "true" : "false")
                : Convert.ToString(token?.ToObject<object>(), System.Globalization.CultureInfo.InvariantCulture) ?? "";
            var stored = OvrasSettings.Format(key, text);
            if (stored != null) changes[key] = stored;
        }
        var problem = "";
        try
        {
            if (changes.Count > 0) OvrasSettings.Save(OvrasSettings.DefaultPath(), changes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            CrashHandler.WriteEntry("hubOvrasSave", ex);
            problem = "write";
        }
        SendOvrasState(problem == "" ? "saved" : problem);
    }

    private void SendOvrasState(string result)
    {
        var path = OvrasSettings.DefaultPath();
        var found = File.Exists(path);
        Dictionary<string, object> values;
        try { values = OvrasSettings.Read(found ? File.ReadAllText(path) : ""); }
        catch (IOException ex)
        {
            CrashHandler.WriteEntry("hubOvrasRead", ex);
            values = OvrasSettings.Read("");
        }
        SendToJS("hubOvrasState", new
        {
            found,
            running = OvrasSettings.IsRunning(),
            result,
            values,
            fields = OvrasSettings.Fields.Select(f => new { key = f.Key, kind = f.Kind, min = f.Min, max = f.Max, step = f.Step }).ToArray(),
        });
    }
}
