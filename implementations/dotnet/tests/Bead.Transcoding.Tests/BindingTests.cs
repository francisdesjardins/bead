using System.Text;
using Bead.Transcoding.V1;
using Google.Protobuf.WellKnownTypes;
using static Bead.Transcoding.Tests.TranscodingFile;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <see cref="HttpBinding"/>: a request bound from its route's variables, its query and its body by
/// <c>http.proto</c>'s rules, then read by Bead's mapping, and a <c>PATCH</c>'s <c>update_mask</c>
/// (transcoding 4). The twins of the TypeScript side's <c>binding.test.ts</c>.
/// </summary>
public sealed class BindingTests
{
    private static readonly HttpBinding Binding = new(Form);

    private static Google.Protobuf.IMessage Bind((string Procedure, HttpRouteTemplate Rule) route, (string Target, string? Body) request)
    {
        return Binding.Bind(
            new BindingRoute { Request = RouteOf(route.Procedure).Request.Descriptor!, Rule = route.Rule, Template = HttpTemplate.Parse(route.Rule.Template) },
            new BindingRequest { Target = request.Target, Body = request.Body is null ? ReadOnlyMemory<byte>.Empty : Encoding.UTF8.GetBytes(request.Body) });
    }

    [Fact]
    public void Binds_a_path_variable_the_query_and_the_body_into_one_request_as_http_proto_s_rules_state()
    {
        var get = new HttpRouteTemplate { Method = "GET", Template = "/v1/{name=shelves/*/books/*}" };
        var archive = new HttpRouteTemplate { Method = "POST", Template = "/v1/{name=shelves/*/books/*}:archive", Body = "*" };

        // * a variable, then the query by JSON names or proto names, `+` a space, a repeated scalar repeated
        Assert.Equal(
            new GetBookRequest
            {
                Name = "shelves/1/books/2",
                Revision = 3,
                Sub = new Inner { Name = "a b", Count = 2 },
                Tags = { "x", "y" },
                At = new Timestamp { Seconds = 1 },
                Color = Color.Green,
                Flag = true,
            },
            Bind(("getBook", get), ("/v1/shelves/1/books/2?revision=3&sub.name=a+b&sub.count=2&tags=x&tags=y&at=1970-01-01T00:00:01Z&color=2&flag=true", null)));

        // the body of the request whole, less what the path binds
        Assert.Equal(
            new GetBookRequest { Name = "shelves/1/books/2", Revision = 7 },
            Bind(("archiveBook", archive), ("/v1/shelves/1/books/2:archive", "{\"revision\":\"7\"}")));
    }

    [Fact]
    public void Refuses_a_parameter_no_field_names_a_field_named_twice_and_a_repeated_message_or_a_map_in_the_query()
    {
        var get = new HttpRouteTemplate { Method = "GET", Template = "/v1/books/{name}" };
        var archive = new HttpRouteTemplate { Method = "POST", Template = "/v1/{name=shelves/*/books/*}:archive", Body = "*" };

        foreach (var target in new[]
        {
            "/v1/books/2?nope=1",
            "/v1/books/2?revision=1&revision=2",
            "/v1/books/2?revision=1&revision=2",
            "/v1/books/2?inners.name=a",
            "/v1/books/2?labels=a",
            "/v1/books/2?sub=a",
            "/v1/books/2?name=a",
            "/v1/books/%FF",
        })
        {
            Assert.Throws<JsonFormException>(() =>
            {
                Bind(("getBook", get), (target, null));
            });
        }

        // a field the path binds that the body sets too, and a query beside a body of the request whole
        Assert.Throws<JsonFormException>(() =>
        {
            Bind(("archiveBook", archive), ("/v1/shelves/1/books/2:archive", "{\"name\":\"x\"}"));
        });
        Assert.Throws<JsonFormException>(() =>
        {
            Bind(("archiveBook", archive), ("/v1/shelves/1/books/2:archive?revision=1", "{}"));
        });
    }

    [Fact]
    public void Reads_a_parameter_without_its_equals_as_an_empty_value_and_an_enum_s_by_its_name_or_its_number()
    {
        var get = new HttpRouteTemplate { Method = "GET", Template = "/v1/books/{name}" };

        // * an empty sequence skipped, a name with no `=` an empty value, false a bool, a character
        // beyond the BMP as it came or percent-encoded
        Assert.Equal(
            new GetBookRequest { Name = "2", Tags = { "", "😀", "😀" }, Sub = new Inner { Name = "a=b" } },
            Bind(("getBook", get), ("/v1/books/2?&flag=false&&tags&tags=😀&tags=%F0%9F%98%80&sub.name=a=b&", null)));
        Assert.Equal(
            new GetBookRequest { Name = "2", Flag = true, Revision = -1 },
            Bind(("getBook", get), ("/v1/books/2?flag=true&revision=-1", null)));

        // an enum by its name or its number; a bool of no value is none
        Assert.Equal(Color.Green, ((GetBookRequest)Bind(("getBook", get), ("/v1/books/2?color=COLOR_GREEN", null))).Color);
        Assert.Equal(Color.Red, ((GetBookRequest)Bind(("getBook", get), ("/v1/books/2?color=1", null))).Color);
        Assert.Equal("no bool", Assert.Throws<JsonFormException>(() =>
        {
            Bind(("getBook", get), ("/v1/books/2?flag", null));
        }).Message);
    }

    [Fact]
    public void Refuses_a_body_that_is_no_object_as_the_request_whole_or_under_a_field_a_variable_sets_inside()
    {
        var whole = new HttpRouteTemplate { Method = "POST", Template = "/v1/{name=shelves/*/books/*}:archive", Body = "*" };
        var sub = new HttpRouteTemplate { Method = "POST", Template = "/v1/books/{sub.name}", Body = "sub" };

        // * the request whole read as its message, in the mapping's words, whatever the path binds
        Assert.Equal("a GetBookRequest that is no object", Assert.Throws<JsonFormException>(() =>
        {
            Bind(("archiveBook", whole), ("/v1/shelves/1/books/2:archive", "1"));
        }).Message);
        Assert.Equal("a field that two of the request set", Assert.Throws<JsonFormException>(() =>
        {
            Bind(("getBook", sub), ("/v1/books/x", "1"));
        }).Message);
    }

    [Fact]
    public void Throws_a_programmer_s_error_for_a_variable_that_names_no_field()
    {
        var crooked = new HttpRouteTemplate { Method = "GET", Template = "/v1/books/{sub.nope}" };

        Assert.Throws<ArgumentException>(() =>
        {
            Bind(("getBook", crooked), ("/v1/books/x", null));
        });

        // and for a target its route's template does not match
        Assert.Throws<ArgumentException>(() =>
        {
            Bind(("getBook", new HttpRouteTemplate { Method = "GET", Template = "/v1/books/{name}" }), ("/v2/other", null));
        });
    }

    [Fact]
    public void Fills_a_PATCH_s_update_mask_with_the_keys_its_body_holds()
    {
        var patch = new HttpRouteTemplate { Method = "PATCH", Template = "/v1/{book.name=shelves/*/books/*}", Body = "book" };

        Assert.Equal(
            new UpdateBookRequest
            {
                Book = new Book { Name = "shelves/1/books/2", Title = "New", Author = new Inner { Name = "Ada" } },
                UpdateMask = new FieldMask { Paths = { "title", "author.name", "pages" } },
            },
            Bind(("updateBook", patch), ("/v1/shelves/1/books/2", "{\"title\":\"New\",\"author\":{\"name\":\"Ada\"},\"pages\":null}")));

        // the query's own mask, where it gives one, is the request's
        Assert.Equal(
            new FieldMask { Paths = { "pages" } },
            ((UpdateBookRequest)Bind(("updateBook", patch), ("/v1/shelves/1/books/2?updateMask=pages", "{\"title\":\"New\"}"))).UpdateMask);
    }
}
