using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace HapsHub.Core;

/// <summary>
/// Reads and changes OVR Advanced Settings' movement settings in its own settings file.
/// Only the changed lines are rewritten; every other byte, including the line endings, stays as it was.
/// OVR Advanced Settings writes the whole file when it closes, so changes only stick while it isn't running.
/// </summary>
public static class OvrasSettings
{
    public const string Section = "playspaceSettings";
    public const string BackupSuffix = ".before-hapshub.ini";

    /// <summary>One setting: how the page shows it and how its value is stored.</summary>
    public sealed record Field(string Key, string Kind, double Min, double Max, double Step, double Default, double Scale = 1);

    /// <summary>The settings the page offers. Numbers are shown divided by Scale (the snap angle is stored in hundredths of a degree).</summary>
    public static readonly Field[] Fields =
    {
        new("moveShortcutLeft", "bool", 0, 1, 1, 0),
        new("moveShortcutRight", "bool", 0, 1, 1, 0),
        new("gravityStrength", "number", 0, 30, 0.1, 9.8),
        new("flingStrength", "number", 0, 10, 0.1, 1),
        new("frictionPercent", "number", 0, 100, 1, 0),
        new("momentumSave", "bool", 0, 1, 1, 0),
        new("dragMult", "number", 0.1, 10, 0.1, 1),
        new("snapTurnAngle", "number", 1, 180, 1, 45, 100),
        new("smoothTurnRate", "number", 1, 1000, 1, 100),
        new("dragComfortFactor", "number", 0, 10, 1, 0),
        new("turnComfortFactor", "number", 0, 10, 1, 0),
        new("lockXToggle", "bool", 0, 1, 1, 0),
        new("lockYToggle", "bool", 0, 1, 1, 0),
        new("lockZToggle", "bool", 0, 1, 1, 0),
    };

    public static string DefaultPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "AdvancedSettings-Team", "OVR Advanced Settings.ini");

    public static bool IsRunning()
    {
        var found = Process.GetProcessesByName("AdvancedSettings");
        foreach (var p in found) p.Dispose();
        return found.Length > 0;
    }

    /// <summary>The page's values (bools as true/false, numbers already divided by Scale). Missing keys get the default.</summary>
    public static Dictionary<string, object> Read(string text)
    {
        var raw = ReadSection(text, Section);
        var values = new Dictionary<string, object>();
        foreach (var field in Fields)
        {
            raw.TryGetValue(field.Key, out var stored);
            if (field.Kind == "bool")
                values[field.Key] = string.Equals(stored, "true", StringComparison.OrdinalIgnoreCase);
            else
                values[field.Key] = double.TryParse(stored, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
                    ? Math.Round(number / field.Scale, 3)
                    : field.Default;
        }
        return values;
    }

    /// <summary>Key/value pairs of one [section]. Later duplicates win, like QSettings.</summary>
    public static Dictionary<string, string> ReadSection(string text, string section)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var inside = false;
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r').Trim();
            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                inside = line[1..^1] == section;
                continue;
            }
            if (!inside) continue;
            var eq = line.IndexOf('=');
            if (eq > 0) result[line[..eq].Trim()] = line[(eq + 1)..].Trim();
        }
        return result;
    }

    /// <summary>
    /// Turns a page value into the stored text, or null when the key isn't one of ours or the value is out of range.
    /// </summary>
    public static string? Format(string key, string value)
    {
        var field = Array.Find(Fields, f => f.Key == key);
        if (field == null) return null;
        if (field.Kind == "bool")
        {
            if (!bool.TryParse(value, out var flag)) return null;
            return flag ? "true" : "false";
        }
        if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) return null;
        if (double.IsNaN(number) || number < field.Min || number > field.Max) return null;
        var stored = number * field.Scale;
        return field.Scale != 1 || field.Step >= 1
            ? Math.Round(stored).ToString(CultureInfo.InvariantCulture)
            : Math.Round(stored, 3).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Sets keys inside [section], keeping every other byte. Keys that aren't there yet are added at the end of the section;
    /// a missing section is added at the end of the file. The file's own line ending is used for new lines.
    /// </summary>
    public static string Apply(string text, string section, IReadOnlyDictionary<string, string> changes)
    {
        var newline = text.Contains("\r\n") ? "\r\n" : "\n";
        var lines = text.Split('\n').ToList();
        var pending = new Dictionary<string, string>(changes, StringComparer.Ordinal);
        var inside = false;
        var lastInSection = -1;
        for (var i = 0; i < lines.Count; i++)
        {
            var bare = lines[i].TrimEnd('\r');
            var trimmed = bare.Trim();
            if (trimmed.StartsWith('[') && trimmed.EndsWith(']'))
            {
                inside = trimmed[1..^1] == section;
                if (inside) lastInSection = i;
                continue;
            }
            if (!inside) continue;
            if (trimmed.Length > 0) lastInSection = i;
            var eq = bare.IndexOf('=');
            if (eq <= 0) continue;
            var key = bare[..eq].Trim();
            if (!changes.TryGetValue(key, out var value)) continue;
            var cr = lines[i].EndsWith('\r') ? "\r" : "";
            lines[i] = bare[..(eq + 1)] + value + cr;
            pending.Remove(key);
        }
        if (pending.Count == 0) return string.Join('\n', lines);

        var cr2 = newline == "\r\n" ? "\r" : "";
        var added = pending.Select(p => $"{p.Key}={p.Value}{cr2}").ToList();
        if (lastInSection >= 0)
        {
            lines.InsertRange(lastInSection + 1, added);
            return string.Join('\n', lines);
        }
        var tail = text.Length == 0 || text.EndsWith('\n') ? "" : newline;
        return text + tail + $"[{section}]" + newline + string.Join(newline, pending.Select(p => $"{p.Key}={p.Value}")) + newline;
    }

    /// <summary>Saves the changes. Keeps one backup of the file as it was before HapsHub first touched it.</summary>
    public static void Save(string path, IReadOnlyDictionary<string, string> changes)
    {
        var bytes = File.Exists(path) ? File.ReadAllBytes(path) : Array.Empty<byte>();
        var bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        var text = new UTF8Encoding(false).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));
        var updated = Apply(text, Section, changes);
        if (updated == text) return;

        var backup = Path.ChangeExtension(path, null) + BackupSuffix;
        if (bytes.Length > 0 && !File.Exists(backup)) File.WriteAllBytes(backup, bytes);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var output = new UTF8Encoding(bom).GetPreamble().Concat(new UTF8Encoding(false).GetBytes(updated)).ToArray();
        var temp = path + ".hapshub-tmp";
        File.WriteAllBytes(temp, output);
        File.Move(temp, path, overwrite: true);
    }
}
