// Builds test/fixtures/ask-jim.json: Community Archive answers about @jposhaughnessy, recorded Nov 5, 2026
// (ca_account; ca_search_tweets in both directions; ca_account_tweets since Nov 1). Texts as archived,
// except one long post of Leo's, shortened to its sentence about Jim.
import { writeFileSync } from "node:fs";
import { askKey } from "../../src/live/ask.ts";

const t = (id: string, user: string, name: string, created_at: string, text: string, extra = {}) => ({ id, user, name, created_at, text, url: `https://x.com/${user}/status/${id}`, ...extra });
const J = (id: string, d: string, text: string, x = {}) => t(id, "jposhaughnessy", "Jim O'Shaughnessy", d, text, x);
const L = (id: string, d: string, text: string, x = {}) => t(id, "leo_guinan", "Uncle Vibecoder", d, text, x);

const answers = {
  [askKey("account", { user: "jposhaughnessy" })]: { username: "jposhaughnessy", name: "Jim O'Shaughnessy", location: "Greenwich, CT/Manhattan, NY", website: "http://www.osv.llc", created_at: "2009-04-02T16:33:50.000Z", followers: 193308 },
  [askKey("search", { q: "leo_guinan", from_user: "jposhaughnessy" })]: [
    J("2101376453329699121", "2026-09-19T18:22:42.000Z", "@leo_guinan Applications for 2027 open January 1, 2027\n\nhttps://www.osvfellowship.com/", { reply_to: { id: "2101374316436668835" } }),
    J("2079966229314379828", "2026-07-22T16:26:07.000Z", "@leo_guinan There ARE ways to deprogram yourself 👇🏻\n\nhttps://x.com/jposhaughnessy/status/1343371350493319169", { reply_to: { id: "2079880508616364435" } }),
    J("2077042070556999773", "2026-07-14T14:46:33.000Z", "@leo_guinan I, on the other hand, am simply lazy 😜", { reply_to: { id: "2076807651615281513" } }),
    J("2036930658451279931", "2026-03-25T22:18:07.000Z", "@leo_guinan I just downloaded this. Let me take a look and see what advice is actionable. Thanks so much for doing this for me!", { reply_to: { id: "2036896994925445537" } }),
    J("1929262865111756898", "2025-06-01T19:44:45.000Z", "@leo_guinan I have a very good memory for anything I read (I'm crap at remembering most \"events\" like who said what at a party) but I use a kind of \"mind palace\" system where reading something fills my mind with quotes I read that relate to it.", { reply_to: { id: "1929261527866999170" } }),
    J("2078924298870255934", "2026-07-19T19:25:52.000Z", "@leo_guinan Alternatively 😜", { reply_to: { id: "2078905472753491983" } }),
  ],
  [askKey("search", { q: "jposhaughnessy", from_user: "leo_guinan" })]: [
    L("2116906636950589494", "2026-11-01T14:54:07.000Z", "Shutting the room down for today and calling it a success.\n\nWe have a working production process now. \n\nNo movie for @jposhaughnessy yet, but we have a trailer.\n\nhttps://youtu.be/wx6pKOZ8vy0?si=VlrwIf3Lza2ODWOA"),
    L("2109641554948173825", "2026-10-12T13:45:16.000Z", "When I was really at the edge of my understanding, I sent @jposhaughnessy a paper my AI wrote and asked him to get feedback from his AI system because I trusted it more than the lab’s models at the time."),
    L("2101655169700151658", "2026-09-20T12:50:13.000Z", "@jposhaughnessy 🫡 I'll work on my application!", { reply_to: { id: "2101376453329699121" } }),
    L("2085359563868442942", "2026-08-06T13:37:18.000Z", "I always loved the way @jposhaughnessy described information. A political speech might have 0 information.\n\nA poem might have a ton.\n\nSo what's the maximum information you can pack into a poem?"),
    L("2076752829780234600", "2026-07-13T19:37:13.000Z", "@jposhaughnessy Just had a thought. \n\nI think Hofstadter’s law is reversed now. \n\nEverything is becoming so easy we have an abundance of time. \n\nI bet there is about to be a huge market for books. \n\nInfinite books. \n\nGood time to be a publisher.", { reply_to: { id: "2076750658120581266" } }),
    L("2105638448254025973", "2026-10-01T12:38:21.000Z", "RT @jposhaughnessy: \"The first principle is that you must not fool yourself—and you are the easiest person to fool.\"\n~Richard P. Feynman"),
  ],
  [askKey("recent", { user: "jposhaughnessy" })]: [
    J("2117624404108521928", "2026-11-03T14:26:16.000Z", "Don't spend time worrying about what other people are thinking of you for in truth, they're probably not thinking about you at all. They're too busy worrying about what other people think of them.", { likes: 92 }),
    J("2117255382573687032", "2026-11-02T13:59:54.000Z", "\"But the point here is: seek out what interests you. Seek out your passions. Find new passions, do new things, try new things. Don’t be boring.\"\n~@trengriffin", { likes: 28 }),
    J("2117257921830498685", "2026-11-02T14:09:59.000Z", "@mbateman 😜", { likes: 1, reply_to: { id: "2117223397931594139" } }),
  ],
};
writeFileSync(new URL("./ask-jim.json", import.meta.url), JSON.stringify({ _doc: "Community Archive answers about @jposhaughnessy, recorded Nov 5, 2026. See make-ask-jim.ts.", answers }, null, 1));
console.log(Object.keys(answers).length, "answers");
