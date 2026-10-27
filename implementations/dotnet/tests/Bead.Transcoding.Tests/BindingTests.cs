using System.Text;
using Bead.Transcoding.Tests.BindingFixtures;
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
    [Fact]
    public void Fills_a_PATCH_mask_from_snake_case_fields_through_nested_and_empty_message_bodies()
    {
        foreach (var body in new[]
        {
            "{\"displayName\":\"Ada\",\"nestedProfile\":{\"displayName\":\"Grace\"},\"emptyProfile\":{}}",
            "{\"display_name\":\"Ada\",\"nested_profile\":{\"display_name\":\"Grace\"},\"empty_profile\":{}}",
        })
        {
            var read = BindOf(
                (PatchRequest.Descriptor, new HttpRouteTemplate { Method = "PATCH", Template = "/v1/profile", Body = "profile" }),
                ("/v1/profile", body));

            Assert.Equal(new PatchRequest
            {
                Profile = new PatchProfile
                {
                    DisplayName = "Ada",
                    NestedProfile = new PatchProfile { DisplayName = "Grace" },
                    EmptyProfile = new PatchProfile(),
                },
                UpdateMask = new FieldMask { Paths = { "display_name", "nested_profile.display_name", "empty_profile" } },
            }, read);
        }
    }

    private static readonly HttpBinding Binding = new(Form);

    private static Google.Protobuf.IMessage Bind((string Procedure, HttpRouteTemplate Rule) route, (string Target, string? Body) request)
    {
        return BindOf((RouteOf(route.Procedure).Request.Descriptor!, route.Rule), request);
    }

    // a request of `route`'s message, whatever procedure takes it, its target split and its variables
    // decoded as its gateway, which matched its path, gives them
    private static Google.Protobuf.IMessage BindOf((Google.Protobuf.Reflection.MessageDescriptor Request, HttpRouteTemplate Rule) route, (string Target, string? Body) request)
    {
        var question = request.Target.IndexOf('?', StringComparison.Ordinal);
        var path = HttpPath.Of(question < 0 ? request.Target : request.Target[..question])
            ?? throw new InvalidOperationException($"{request.Target} matches no route");

        return Binding.Bind(route.Request, new BindingOptions
        {
            Variables = HttpTemplate.Parse(route.Rule.Template).ValuesOf(path),
            Query = question < 0 ? null : request.Target[(question + 1)..],
            Body = request.Body is { } body ? new ReadOnlyMemory<byte>(Encoding.UTF8.GetBytes(body)) : null,
            RouteBody = route.Rule.Body,
            IsPatch = route.Rule.Method == "PATCH",
        });
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

        foreach (var (target, reason) in new[]
        {
            ("/v1/books/2?nope=1", "a parameter no field path names"),
            ("/v1/books/2?inners.name=a", "a parameter no field path names"),
            ("/v1/books/2?revision=1&revision=2", "a field the query names twice"),
            ("/v1/books/2?sub.count=1&sub.count=2", "a field the query names twice"),
            ("/v1/books/2?inners=a", "a parameter of a map or a repeated message"),
            ("/v1/books/2?labels=a", "a parameter of a map or a repeated message"),
            ("/v1/books/2?sub=a", "a parameter of a message"),
            ("/v1/books/2?tags=%FF", "a query whose bytes are not UTF-8"),
            ("/v1/books/2?revision=1e3", "an int64 string off -?(0|[1-9][0-9]*)"),
            ("/v1/books/2?flag=1", "no bool"),
            ("/v1/books/2?name=a", "a parameter of a field the route binds otherwise"),
        })
        {
            Assert.Equal(reason, Assert.Throws<JsonFormException>(() =>
            {
                Bind(("getBook", get), (target, null));
            }).Message);
        }

        // a repeated scalar repeats, an empty sequence skipped; a % that two digits do not follow stays
        Assert.Equal(new GetBookRequest { Name = "2", Tags = { "a", "b" } }, Bind(("getBook", get), ("/v1/books/2?tags=a&&tags=b", null)));
        Assert.Equal("100%", ((GetBookRequest)Bind(("getBook", new HttpRouteTemplate { Method = "GET", Template = "/v1/books" }), ("/v1/books?name=100%", null))).Name);

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
        // beyond the BMP percent-encoded
        Assert.Equal(
            new GetBookRequest { Name = "2", Tags = { "", "😀" }, Sub = new Inner { Name = "a=b" } },
            Bind(("getBook", get), ("/v1/books/2?&flag=false&&tags&tags=%F0%9F%98%80&sub.name=a=b&", null)));
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

        // a name of no `=` that the path does not bind, an empty value
        Assert.Equal(
            new GetBookRequest { Revision = 2, Color = Color.Green },
            Bind(("getBook", new HttpRouteTemplate { Method = "GET", Template = "/v1/books" }), ("/v1/books?name&revision=2&color=COLOR_GREEN", null)));
    }

    [Fact]
    public void Binds_a_wrapper_and_a_well_known_type_of_a_string_form_from_a_parameter_never_a_Struct_a_Value_or_a_ListValue()
    {
        var route = (Everything.Descriptor, new HttpRouteTemplate { Method = "GET", Template = "/v1/every" });

        Assert.Equal(
            new Everything { At = new Timestamp { Seconds = 1 }, WrappedString = "x", WrappedInt64 = 7, WrappedBool = true, Took = new Duration { Seconds = 1, Nanos = 500_000_000 } },
            BindOf(route, ("/v1/every?wrappedInt64=7&wrappedBool=true&took=1.5s&wrappedString=x&at=1970-01-01T00:00:01Z", null)));

        foreach (var parameter in new[] { "extra", "anyValue", "list" })
        {
            Assert.Equal("a parameter of a message", Assert.Throws<JsonFormException>(() =>
            {
                BindOf(route, ($"/v1/every?{parameter}=x", null));
            }).Message);
        }
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

    [Fact]
    public void Fills_no_update_mask_path_of_a_PATCH_s_body_that_is_no_object_and_refuses_a_member_of_it_that_names_no_field()
    {
        var patch = new HttpRouteTemplate { Method = "PATCH", Template = "/v1/books", Body = "book" };

        Assert.Equal(new UpdateBookRequest { UpdateMask = new FieldMask() }, Bind(("updateBook", patch), ("/v1/books", "null")));
        Assert.Equal("a key no field names", Assert.Throws<JsonFormException>(() =>
        {
            Bind(("updateBook", patch), ("/v1/books", "{\"title\":\"t\",\"nope\":1}"));
        }).Message);
    }
}
