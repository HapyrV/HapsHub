using System.Text;

namespace HapsHub.Core;

public sealed record ExportedNote(string Kind, string Id, string Name, string Note, string Edited, string Source);

/// <summary>Your notes as a spreadsheet file.</summary>
public static class NotesExport
{
    public static string BuildCsv(IEnumerable<ExportedNote> notes)
    {
        var csv = new StringBuilder("kind,id,name,note,edited,source\r\n");
        foreach (var note in notes)
            csv.Append(string.Join(",", new[] { note.Kind, note.Id, note.Name, note.Note, note.Edited, note.Source }.Select(Field))).Append("\r\n");
        return csv.ToString();
    }

    private static string Field(string value)
    {
        value ??= "";
        // A note starting like this would run as a formula in a spreadsheet.
        if (value.Length > 0 && "=+-@\t\r".Contains(value[0])) value = "'" + value;
        return value.IndexOfAny(new[] { ',', '"', '\r', '\n' }) >= 0 ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
    }
}
