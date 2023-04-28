import bsky, { AppBskyNotificationListNotifications, LikeRecord, PostRecord } from '@atproto/api';
const { BskyAgent } = bsky;
const { RichText } = bsky;
import { backOff } from "exponential-backoff";
import * as dotenv from 'dotenv';
import process from 'node:process';
dotenv.config();

import { FullMarket, Manifold } from 'manifold-sdk';
import { Configuration, OpenAIApi } from 'openai';
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const agent = new BskyAgent({
  service: 'https://bsky.social',
});

const manifold = new Manifold(process.env.MANIFOLD_API_KEY);

async function callGPT4(prompt: string) {
  try {
    const response = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        {"role": "user", "content": prompt}
      ],
    })

    if (response.status === 429) {
      // Wait for 1 second and try again
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await callGPT4(prompt);
    }

    if (response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message?.content.trim();
    } else {
      throw new Error("No response from GPT-4");
    }
  } catch (error) {
    console.error("Error calling GPT-4:", error);

    throw error;
  }
}

type Post = {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName: string;
    description: string;
    avatar: string;
    indexedAt: string;
    viewer: {
      muted: boolean;
      followedBy: string;
    };
    labels: string[];
  };
  record: Record;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  labels: string[];
};

type Reply = {
  root: {
    uri: string;
    cid: string;
  };
  parent: {
    uri: string;
    cid: string;
  };
}

type Record = {
  text: string;
  reply: Reply;
  facets: any[];
  createdAt: string;
};

async function createPredictionMarket(post: Post, resolver: string) {
  const post_text = post.record.text
  const date = post.record.createdAt

  const author_handle = post.author.handle

  // Convert the post into a question phrased like a prediction market
  const prompt = `Convert a post into a suitably structured question for a prediction market,
  including resolution criteria, timeline.
  As useful context when setting the market resolution dates, the current date/time is ${date} (in UTC).
  If you reference a user in the market title, preface their handle with an @ symbol.
  The response should be at most 120 characters.
  Responses should always be in the form of a YES/NO question.

  Example:
  Post: "I caught the very tail end of the hedge fund boom when it was clear that employee compensation on Wall Street was going to be structurally lower going forward than it was before the mid-2000's, and it's the same exact dynamic in Silicon Valley today."
  Author: vivalapanda.moe
  Response: "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area"

  Post: "You'll be able to get one Google L5, give them GPT-4-Copilot, and have them modernize the software systems for a whole org within a year

  That means you can afford to have them work on something like improving farm automation, unlike the previously needed 10 person team"
  Author: kache.bsky.social
  Response: "Will I believe my prediction about AI enabling more SWEs to solve less lucrative problems by shrinking team sizes to have been fulfilled by EoY 2030"

  Post: "An environmental contaminant that we don't understand and won't for another decade at least responsible for this stuff, I'd bet money on it.  Blaming food or sedentary lifestyles is a cop out."
  Author: mfoldbot.bsky.social
  Response: "Will the contaminant hypothesis of modern obesity be judged true by expert consensus before 2032?"

  Post: "Testing some stuff! I'll have a bot built by the end of the week I hope!"
  Author: testing.bsky.social
  Response: "Will @testing.bsky.social have a bot built by April 21st, 2023?"

  Post: "prediction market: when will i see a stranger using bluesky on public transit for the first time"
  Author: emily.bsky.team
  Response: "Will @emily.bsky.team see a stranger using bluesky on public transit before 2024?"

  Post: "${post_text}"
  Author: ${author_handle}
  Response:`;
  const question = await callGPT4(prompt);

  // Check if the question is too long
  if (question.length > 120) {
    throw new Error("Question is too long");
  }

  // Create the JSON from the question
  const jsonPrompt = `Create a manifold.markets prediction market JSON from a question. Do not use trailing commas. Begin your output with
    [BEGIN OUTPUT] and end it with [END OUTPUT]. Use the YYYY-DD-DDTHH:MM:SS.000Z timestamp format for the closeTime (use UTC).
    As useful context when setting the market resolution dates, the current date/time is ${date} (in UTC).
    You should only ever create BINARY markets.

    Example:
    Post: "I caught the very tail end of the hedge fund boom when it was clear that employee compensation on Wall Street was going to be structurally lower going forward than it was before the mid-2000's, and it's the same exact dynamic in Silicon Valley today."
    Question: "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area"
    [BEGIN OUTPUT]
    {
      "outcomeType": "BINARY",
      "question": "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area",
      "closeTime": "2025-01-01T00:00:00.000Z",
      "initialProb": 50,
      "descriptionMarkdown": "Resolution fully based on the individual judgement of the following resolver."
    }
    [END OUTPUT]

    Input: ${question}
    [BEGIN OUTPUT]
  `;

  let json = await callGPT4(jsonPrompt);
  // Strip begin and end output
  json = json.replace('[BEGIN OUTPUT]', '').replace('[END OUTPUT]', '');

  console.log('raw json: ', json)

  // parse the json
  const marketJSON = JSON.parse(json);

  // Convert the closeTime string to a Date object and
  // store it as a unix timestamp in ms 
  marketJSON.closeTime = new Date(marketJSON.closeTime).getTime();

  // Add the resolver
  marketJSON.descriptionMarkdown += "\n\nResolver: @" + resolver;
  // Get the post ID from the last fragment ("/" seperated) of the uri
  const postID = post.uri.split('/').pop();
  // Add the market link to the description
  marketJSON.descriptionMarkdown += "\n\nMarket created for [this post](https://staging.bsky.app/profile/" + post.author.handle + "/post/" + postID + ")";

  // log the market json
  console.log('marketJSON: ', marketJSON)

  return await manifold.createMarket(marketJSON);
}

async function replyWithMarketLink(originalPost: Post, notif: AppBskyNotificationListNotifications.Notification, resolver: string) {
  const createMarketResp = await createPredictionMarket(originalPost, resolver);

  // wait 5 seconds
  await new Promise((resolve) => setTimeout(resolve, 5000));
  
  // Get a link for the market
  const fullMarket = await manifold.getMarket({
    slug: createMarketResp.slug,
  })

  // Use richtext to create a post that links to the market
  const rt = new RichText({text: `${fullMarket.question}: Bet on it at ${fullMarket.url}`});
  await rt.detectFacets(agent);

  // Post the reply
  await agent.post({
    text: rt.text,
    facets: rt.facets,
    reply: {
      root: {
        uri: notif.uri,
        cid: notif.cid,
      },
      parent: {
        uri: notif.uri,
        cid: notif.cid,
      },
    }
  });

  console.log('posted reply: ', rt.text, rt.facets)
}

function getResolverFromText(text: string): string | null {
  // Extract the resolver from the text, which may have multiple lines (e.g. Resolver: @vivalapanda.moe)
  const resolverMatch = text.match(/Resolver: @([a-zA-Z0-9._-]+)/);
  return resolverMatch ? resolverMatch[1] : null;
}

// extract the post from the mention/notif
async function extractReplyPost(mention: Reply): Promise<Post | undefined> {
  const postThread = await agent.getPostThread({
    uri: mention.parent.uri,
  });

  if (postThread.success) {
    return postThread.data?.thread?.post as Post;
  }

  return undefined;
}

async function handleMention(notifParent: Post, notif: AppBskyNotificationListNotifications.Notification) {
  const mentionRecord = notif.record as Record
  const resolver = getResolverFromText(mentionRecord.text) || notif.author.handle;

  await replyWithMarketLink(notifParent, notif, resolver);
}

// Get market data from a post
async function extractMarketFromText(text: string): Promise<FullMarket | undefined> {
  // Get the link to the market from the post (Just match the only link in the post)
  // e.g Will @vivalapanda.moe's bot be fixed by end of April 28th, 2023?: Bet on it at https://manifold.markets/bskybot/will-vivalapandamoes-bot-be-fixed-b
  const marketLinkMatch = text.match(/https:\/\/manifold.markets\/bskybot\/([a-zA-Z0-9_-]+)/);
  if (!marketLinkMatch) {
    console.log('Could not find market link in post');
    return undefined;
  }

  // Get the market id from the link
  const marketSlug = marketLinkMatch[1];

  // Get the contents of the market so we can check to make sure the resolver matches
  return await manifold.getMarket({
    slug: marketSlug,
  });
}

async function handleMarketResolution(notifParent: Post, notif: AppBskyNotificationListNotifications.Notification, resolution: "YES" | "NO" | "CANCEL") {
  console.log(`Market resolution: ${resolution}`);

  const market = await extractMarketFromText(notifParent.record.text);
  console.log("Market: ", market);

  if (!market) {
    console.log('Could not find market');
    return;
  }

  // Extract the resolver from the market text
  const resolverMatch = getResolverFromText(market.textDescription);

  // Check that the resolver matches the resolver in the market
  console.log(`Resolver: ${resolverMatch}`);
  console.log(`Notif author: ${notif.author.handle}`);
  if (!resolverMatch || (resolverMatch.toLowerCase() !== notif.author.handle.toLowerCase())) {
    console.log('Resolver does not match');
    return;
  }

  // Resolve the market
  manifold.resolveMarket({
    marketId: market.id,
    outcome: resolution,
  });
  console.log('Resolved market');
}

async function listenForMentions() {
  // Loop forever until the process is killed
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // listen for mentions using listNotifications
    let response_notifs: AppBskyNotificationListNotifications.Response
    try {
      response_notifs = await agent.listNotifications()
    } catch (e) {
      console.log('error', e)
      // wait 1 minute before trying again
      await new Promise((resolve) => setTimeout(resolve, 60000));
      continue
    }
    const notifs = response_notifs.data.notifications

    // Mark all these notifs as read

    // Count the number of notifications which are unread
    // and which are also mentions
    const unread_mentions = notifs.filter(notif => {
      return (
        (notif.reason === 'mention' || notif.reason === 'reply') &&
        notif.isRead === false
      )
    })
    if (unread_mentions.length > 0) {
      console.log(`Found ${unread_mentions.length} new mentions.`)
    }
    
    await agent.updateSeenNotifications()

    await Promise.all(
      unread_mentions.map(async notif => {
        const notifRecord = notif.record as Record
        console.log('notifRecord', notifRecord)
        
        // if record.reply has no parent, skip it
        if (!notifRecord?.reply?.parent) {
          console.log('skipping because has no parent')
          return
        }

        // if record.text doesn't include our handle, skip it
        const ourHandle = process.env.BSKY_USERNAME
        // TODO: centralize checking and storing of the env variables
        if (ourHandle && !notifRecord.text.includes(ourHandle)) {
          console.log('skipping because does not include our handle')
          return
        }
        
        try {
          const notifParent = await extractReplyPost(notifRecord.reply);
          console.log('notifParent', notifParent)

          if (notifParent) {
            // Check if the notifParent.record.text contains "Resolve: YES" anywhere in the string
            const resolutionMatch = notifRecord.text.match(/Resolve:\s*(YES|NO|CANCEL)/i);
            if (resolutionMatch) {
              // this is a reply to one of our posts, check if it contains a resolution
              console.log('handling market resolution')
              const resolution = resolutionMatch[1];

              // Type resolution as one of "YES" | "NO" | "MKT" | "CANCEL"
              const typedResolution = resolution as "YES" | "NO" | "CANCEL";

              await handleMarketResolution(notifParent, notif, typedResolution);
            } else {
              console.log('handling market creation')
              await handleMention(notifParent, notif);
            }
          }

          console.log('not a reply, skipping')
          return
        } catch (e: any) {
            // Print the error and the short stacktrace but not the full response
            console.log('error', e.message);
            console.log('stack', e.stack);
        }
      })
    );

    // Wait 30 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
}

// function to test callgpt4
async function testCallGpt4() {
  const prompt = 'Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area';
  const question = await callGPT4(prompt);
  console.log('question', question)
}

async function main() {
  // login to the agent
  if (!process.env.BSKY_USERNAME || !process.env.BSKY_PASSWORD) {
    throw new Error('BSKY_USERNAME and BSKY_PASSWORD must be set in the environment');
  }

  const username = process.env.BSKY_USERNAME;
  const password = process.env.BSKY_PASSWORD;

  // login to the agent. If it fails, do exponential backoff
  await backOff(() => agent.login({ identifier: username, password: password }), { maxDelay: 60000, numOfAttempts: 10 });

  // await testCallGpt4();
  await listenForMentions();
}

main().catch(error => {
  console.error('Error in main function:', error);
});
