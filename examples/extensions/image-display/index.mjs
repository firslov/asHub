const escape = text => String(text).replace(/[\\\[\]`*_<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
export default function activate(ctx) {
    const resources = ctx.services?.imageResources;
    if (!ctx.agent || !resources)
        return;
    ctx.agent.registerTool({
        name: 'display_images',
        description: 'Show useful existing images, screenshots or charts inline in your answer. Publish 1–4 PNG/JPEG/WebP files inside this conversation’s working directory. Include the returned Markdown next to the relevant explanation in your reply. This displays files to the user; it does not inspect their visual contents. Use only when an image helps the task, not for every tool screenshot. Do not publish unrelated or sensitive files. Keep captions brief. Image creation and screenshot capture belong to other tools.',
        readOnly: true, modifiesFiles: false,
        input_schema: { type: 'object', additionalProperties: false, properties: { images: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', maxLength: 8192 }, caption: { type: 'string', maxLength: 160 } }, required: ['path', 'caption'] } } }, required: ['images'] },
        async execute(args, _chunk, execution) {
            if (!args || !Array.isArray(args.images) || args.images.length < 1 || args.images.length > 4 || args.images.some(i => !i || typeof i.path !== 'string' || !i.path.trim() || i.path.length > 8192 || typeof i.caption !== 'string' || !i.caption.trim() || i.caption.length > 160))
                return { content: 'Provide 1–4 images with a path and a short caption.', exitCode: 1, isError: true };
            const results = [];
            for (const input of args.images) {
                execution?.signal?.throwIfAborted();
                try {
                    const image = await resources.publish(input.path, execution?.signal);
                    results.push({ markdown: `![${escape(input.caption)}](${image.ref})`, width: image.width, height: image.height });
                }
                catch (e) {
                    execution?.signal?.throwIfAborted();
                    results.push({ caption: input.caption, error: String(e.message || e) });
                }
            }
            const failed = results.every(r => r.error);
            return { content: JSON.stringify({ images: results, note: 'Include successful Markdown in your answer. Original image bytes are not added to model context.' }), exitCode: failed ? 1 : 0, isError: failed };
        }
    });
}
