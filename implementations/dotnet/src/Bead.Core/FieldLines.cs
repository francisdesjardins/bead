namespace Bead;

/// <summary>
/// A request field sent in more than one field line, read as one value (spec 15.12): its lines as
/// they came, an empty one among them, joined in their order by <c>", "</c> (RFC 9110 §5.3), as
/// every side joins them.
/// </summary>
internal static class FieldLines
{
    /// <summary>
    /// The lines joined; none when the request sends none, which is not empty.
    /// </summary>
    public static string? JoinedOf(IReadOnlyList<string?> lines)
    {
        ArgumentNullException.ThrowIfNull(lines);

        // ! never StringValues.ToString(), which drops an empty line and joins the rest by ","
        return lines.Count == 0 ? null : string.Join(", ", lines.Select((line) =>
        {
            return line ?? "";
        }));
    }

    /// <summary>
    /// Whether a body is sent as it is (spec 15.12): its <c>Content-Encoding</c> lines a list of no
    /// coding, or of <c>identity</c> once, in any case; each element trimmed of its whitespace, an
    /// empty one ignored (RFC 9110 §5.6.1.2), so an absent field and an empty one list nothing.
    /// </summary>
    public static bool IsUnencoded(IReadOnlyList<string?> lines)
    {
        ArgumentNullException.ThrowIfNull(lines);

        var codings = lines.SelectMany((line) =>
        {
            return (line ?? "").Split(',');
        }).Select((coding) =>
        {
            return coding.Trim(' ', '\t');
        }).Where((coding) =>
        {
            return coding.Length != 0;
        }).ToList();

        return codings.Count == 0 || (codings.Count == 1 && codings[0].Equals("identity", StringComparison.OrdinalIgnoreCase));
    }
}
