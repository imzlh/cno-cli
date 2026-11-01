// Target for `cno serve` CLI flag tests: the CLI layer requires the
// `default.fetch` export shape instead of a self-hosted Deno.serve call.
export default {
    fetch(_request: Request) {
        return new Response('cli-ok');
    },
};
